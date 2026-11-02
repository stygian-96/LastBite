"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CustomerShell, outletHref } from "@/components/customer";
import { Illo, illoFor } from "@/components/Illo";
import { Button, Field, LinkButton, Notice, PageSkeleton, Sheet, Switch } from "@/components/ui";
import { brand } from "@/config/brand";
import { api, errorCode, errorMessage, type Profile } from "@/lib/api";
import { initials, phoneMasked, rupees, shortName } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";

function EditSheet({ me, onClose }: { me: Profile; onClose: () => void }) {
  const { setMe } = useSession();
  const [name, setName] = useState(me.name ?? "");
  const [email, setEmail] = useState(me.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      setMe(await api.updateProfile({ name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}) }));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title="Edit profile" onClose={onClose}>
      <Field id="edit-name" label="Your name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
      <Field id="edit-email" label="Email (optional)" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <Button onClick={save} disabled={busy || name.trim().length < 2}>
        Save
      </Button>
    </Sheet>
  );
}

function DeleteSheet({ onClose }: { onClose: () => void }) {
  const { setMe } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount();
      setMe(null);
      router.replace("/");
    } catch (err) {
      setError(errorCode(err) === "active_order" ? "You have an active order. Collect it first, then delete your account." : errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title="Delete your account?" onClose={onClose}>
      <p className="text-sm leading-normal text-body">This removes your name and phone number and can’t be undone. We keep order records for accounting.</p>
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <Button variant="danger" onClick={remove} disabled={busy}>
        Delete my account
      </Button>
      <Button variant="quiet" onClick={onClose}>
        Keep my account
      </Button>
    </Sheet>
  );
}

export default function ProfilePage() {
  const { me, loading, setMe, signOut } = useSession();
  const router = useRouter();
  const [sheet, setSheet] = useState<"edit" | "delete" | null>(null);
  const following = useQuery(() => api.getFollowing(), [me?.id], { enabled: !!me });

  if (loading) return <PageSkeleton />;

  if (!me) {
    return (
      <CustomerShell>
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 px-4 pt-[18px]">
          <h1 className="text-2xl font-bold">Profile</h1>
          <Notice big="0" band="bags rescued" title="Your impact starts tonight">
            <p className="text-[13px] leading-normal text-body">Sign in and every bag you collect adds to your count and the money you’ve saved.</p>
            <LinkButton href="/signin?next=/profile" size="md">
              Sign in
            </LinkButton>
          </Notice>
        </div>
      </CustomerShell>
    );
  }

  async function savePref(patch: { whatsappOptIn?: boolean; marketingOptIn?: boolean }) {
    setMe({ ...me!, ...patch });
    try {
      setMe(await api.updateProfile(patch));
    } catch {
      setMe(me);
    }
  }

  const list = following.data ?? [];
  const hasImpact = me.impact.bagsCollected > 0;

  return (
    <CustomerShell>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 px-4 pb-4 pt-[18px]">
        <div className="flex items-center gap-3.5">
          <span className="flex size-[60px] items-center justify-center rounded-full bg-coral text-[22px] font-bold text-on-coral">{initials(me.name)}</span>
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="text-xl font-bold">{shortName(me.name) || "Add your name"}</span>
            <span className="tabular text-sm text-muted">{phoneMasked(me.phone)}</span>
          </span>
          <button type="button" onClick={() => setSheet("edit")} className="h-10 rounded-full border border-line bg-white px-3.5 text-[13px] font-medium">
            Edit
          </button>
        </div>

        {hasImpact ? (
          <section className="relative flex flex-col gap-3.5 overflow-hidden rounded-[22px] bg-dark p-[18px] text-white">
            <div className="absolute -right-6 -top-6 flex size-[120px] items-center justify-center rounded-full bg-dark-2">
              <Illo kind="bakery" size={80} />
            </div>
            <span className="relative text-sm text-dark-sub">Your impact so far</span>
            <div className="relative grid grid-cols-2 gap-3">
              <span className="flex flex-col">
                <span className="tabular text-[38px] font-black text-coral">{me.impact.bagsCollected}</span>
                <span className="text-[13px] text-dark-sub">bags rescued</span>
              </span>
              <span className="flex flex-col">
                <span className="tabular text-[38px] font-black">{rupees(me.impact.moneySavedPaise)}</span>
                <span className="text-[13px] text-dark-sub">saved vs usual price</span>
              </span>
            </div>
          </section>
        ) : (
          <Notice big="0" band="bags rescued" title="Your impact starts tonight">
            <p className="text-[13px] leading-normal text-body">Every bag you collect adds to your count and the money you’ve saved.</p>
            <LinkButton href="/browse" size="md">
              See tonight’s bags
            </LinkButton>
          </Notice>
        )}

        <section className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[17px] font-medium">Following</h2>
            <span className="text-[13px] text-muted">{list.length}</span>
          </div>
          {list.length > 0 ? (
            <div className="no-scrollbar flex gap-3.5 overflow-x-auto">
              {list.map((outlet) => (
                <Link key={outlet.outletId} href={outletHref(outlet) ?? "#"} className="flex w-[76px] flex-none flex-col items-center gap-1.5 text-center text-xs no-underline">
                  <span className="flex size-16 items-center justify-center rounded-full bg-fill-2">
                    <Illo kind={illoFor(outlet.category)} size={48} />
                  </span>
                  {outlet.brandName}
                </Link>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1 rounded-[18px] bg-fill p-4 text-[13px] text-muted">
              <strong className="text-[15px] font-medium text-ink">Follow a vendor you love</strong>
              Open a vendor page and tap Follow. We’ll WhatsApp you when they list.
            </div>
          )}
        </section>

        <section className="flex flex-col gap-1">
          <h2 className="mb-1.5 text-[17px] font-medium">Notifications</h2>
          <Switch
            label="WhatsApp updates"
            hint="Codes, refunds and pickup reminders. Off sends them by SMS"
            on={me.whatsappOptIn}
            onChange={(on) => savePref({ whatsappOptIn: on })}
          />
          <Switch label="Offers and news" hint="At most once a week" on={me.marketingOptIn} onChange={(on) => savePref({ marketingOptIn: on })} />
        </section>

        <nav aria-label="Help and legal" className="flex flex-col overflow-hidden rounded-[18px] bg-fill">
          <Link href="/help" className="flex min-h-[52px] items-center justify-between border-b border-[#eaeaea] px-4 text-[15px] no-underline">
            Help &amp; refund policy<span aria-hidden="true">›</span>
          </Link>
          <Link href="/partner" className="flex min-h-[52px] items-center justify-between px-4 text-[15px] no-underline">
            Sell on {brand.name}
            <span aria-hidden="true">›</span>
          </Link>
        </nav>

        <button
          type="button"
          onClick={async () => {
            await signOut();
            router.replace("/browse");
          }}
          className="min-h-12 text-[15px] font-medium text-danger"
        >
          Log out
        </button>
        <button type="button" onClick={() => setSheet("delete")} className="min-h-10 text-[13px] text-muted underline">
          Delete account
        </button>
      </div>
      {sheet === "edit" && <EditSheet me={me} onClose={() => setSheet(null)} />}
      {sheet === "delete" && <DeleteSheet onClose={() => setSheet(null)} />}
    </CustomerShell>
  );
}
