"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AdminsView, InventoryView, ProfileCard, VendorsView } from "@/components/admin";
import { FormError, TextArea } from "@/components/forms";
import { Button, Chip, ErrorState, Logo, PageSkeleton, StatusChip, Tabs } from "@/components/ui";
import { api, errorDetails, errorMessage, errorStatus, type Application, type ApplicationTab, type OutletStatus, type ReviewedDocument } from "@/lib/api";
import { shortDate } from "@/lib/format";
import { useHashTab, useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";

const DOC_LABEL = { fssai: "FSSAI licence", pan: "PAN", gst: "GST", bank_proof: "Bank proof" };
const DOC_STATUS = {
  pending: { label: "Not reviewed", tone: "wait" as const },
  approved: { label: "Looks good", tone: "ok" as const },
  rejected: { label: "Needs fixing", tone: "warn" as const },
  replaced: { label: "Replaced", tone: "info" as const },
};

function documentFacts(app: Application, doc: ReviewedDocument) {
  const account = app.payoutAccount;
  if (doc.kind === "fssai") return `${app.outlet.fssaiNumber ?? "No number"} · valid to ${app.outlet.fssaiExpiresOn ?? "?"}`;
  if (doc.kind === "pan") return account ? `•••• ${account.panLast4} · ${account.legalName}` : "";
  if (doc.kind === "bank_proof") return account ? `${account.ifsc} · ••${account.accountLast4} · ${account.holderName}` : "";
  return app.outlet.gstin ?? "Not registered (declared)";
}

function DocumentRow({ app, doc, onChanged }: { app: Application; doc: ReviewedDocument; onChanged: () => void }) {
  const [flagging, setFlagging] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = DOC_STATUS[doc.status];
  const reviewable = doc.status === "pending";
  // An approved file can still be sent back while the outlet isn't live.
  const reopenable = doc.status === "approved" && !["live", "suspended"].includes(app.outlet.status);

  async function review(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.reviewDocument(doc.id, { approve, ...(approve ? {} : { reason: reason.trim().replace(/\.+$/, "") }) });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className={`flex flex-col gap-2.5 rounded-2xl border-[1.5px] p-3 ${flagging ? "border-coral" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <a href={doc.url} target="_blank" rel="noreferrer" className="rounded-lg bg-fill px-2.5 py-2 text-xs font-medium">
          View file
        </a>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-sm font-medium">{DOC_LABEL[doc.kind]}</strong>
          <span className="text-xs text-muted">{documentFacts(app, doc)}</span>
          {doc.rejectionReason && <span className="text-xs text-danger">{doc.rejectionReason}</span>}
        </span>
        {reviewable ? (
          <span className="flex gap-1.5">
            <button type="button" disabled={busy} onClick={() => review(true)} className="min-h-10 rounded-full border border-[#dddddd] px-3 text-[13px] font-medium">
              Looks good
            </button>
            <button type="button" disabled={busy} aria-pressed={flagging} onClick={() => setFlagging(!flagging)} className={`min-h-10 rounded-full border px-3 text-[13px] font-medium ${flagging ? "border-coral bg-coral text-on-coral" : "border-[#dddddd]"}`}>
              Needs fixing
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <StatusChip tone={status.tone}>{status.label}</StatusChip>
            {reopenable && (
              <button
                type="button"
                aria-pressed={flagging}
                onClick={() => setFlagging(!flagging)}
                className={`min-h-10 rounded-full border px-3 text-[13px] font-medium ${flagging ? "border-coral bg-coral text-on-coral" : "border-[#dddddd]"}`}
              >
                Ask to change
              </button>
            )}
          </span>
        )}
      </div>
      {flagging && (reviewable || reopenable) && (
        <>
          <TextArea id={`reason-${doc.id}`} label="Message to vendor (sent on WhatsApp and shown on their status screen)" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
          <Button size="md" disabled={busy || !reason.trim()} onClick={() => review(false)}>
            Send back to vendor
          </Button>
        </>
      )}
      <FormError message={error} />
    </div>
  );
}

const APP_STATUS: Partial<Record<OutletStatus, { label: string; tone: "wait" | "warn" | "info" | "ok" | "coral" }>> = {
  in_review: { label: "Under review", tone: "wait" },
  changes_needed: { label: "Sent back", tone: "coral" },
  draft: { label: "Not submitted", tone: "info" },
  rejected: { label: "Rejected", tone: "warn" },
  live: { label: "Live · renewal", tone: "ok" },
  suspended: { label: "Inactive · renewal", tone: "info" },
};

const MESSAGE_LABEL = "Message to vendor (sent on WhatsApp and shown in their dashboard)";

function Detail({ app, onChanged }: { app: Application; onChanged: () => void }) {
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"changes" | "reject" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = app.documents.some((doc) => doc.status === "pending");
  const { outlet } = app;
  const chip = APP_STATUS[outlet.status] ?? { label: outlet.status, tone: "info" as const };
  const inReview = outlet.status === "in_review";
  const rejectable = ["draft", "in_review", "changes_needed"].includes(outlet.status);

  async function decide(decision: "approve" | "request_changes" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await api.decideOutlet(outlet.id, { decision, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setMode(null);
      setReason("");
      onChanged();
    } catch (err) {
      const fixes = errorDetails(err).fixes?.map((fix) => fix.message).join(". ");
      setError(fixes || errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Application detail" className="flex min-w-0 flex-1 flex-col gap-3.5 p-4 lg:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">{app.brand.name}</h1>
          <span className="text-[13px] text-muted">
            {outlet.category} · {outlet.branchName}
            {outlet.submittedAt ? ` · applied ${shortDate(outlet.submittedAt)}` : ` · started ${shortDate(outlet.createdAt)}`}
          </span>
        </div>
        <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
      </div>

      {outlet.status === "changes_needed" && (
        <div className="rounded-2xl bg-wait-bg p-3 text-[13px] leading-normal text-wait-fg">
          <strong className="font-medium">Waiting on the vendor.</strong> {outlet.changesReason ?? "Flagged documents are marked below."}
        </div>
      )}
      {outlet.status === "draft" && (
        <div className="rounded-2xl bg-fill p-3 text-[13px] leading-normal text-body">The vendor hasn’t sent this yet. What they’ve filled in so far is below.</div>
      )}
      {outlet.status === "rejected" && (
        <div className="rounded-2xl bg-warn-bg p-3 text-[13px] leading-normal text-warn-fg">
          <strong className="font-medium">Rejected:</strong> {outlet.rejectionReason ?? "No reason recorded."}
        </div>
      )}

      <div className="grid gap-2 rounded-2xl bg-fill p-3.5 text-[13px] leading-normal lg:grid-cols-2">
        <span>
          <span className="text-muted">Address</span>
          <br />
          {outlet.address ?? "—"} {outlet.pincode ?? ""}
        </span>
        <span>
          <span className="text-muted">Maps link</span>
          <br />
          {outlet.mapsUrl ? (
            <a href={outlet.mapsUrl} target="_blank" rel="noreferrer">
              Open in Google Maps
            </a>
          ) : (
            "—"
          )}
        </span>
      </div>

      {app.warnings.map((warning) => (
        <div key={warning.code} role="alert" className="rounded-2xl bg-wait-bg p-3 text-[13px] text-wait-fg">
          {warning.message}
        </div>
      ))}

      <h2 className="text-[17px] font-medium">Documents</h2>
      {app.documents.length === 0 && <p className="text-sm text-muted">No files uploaded yet.</p>}
      {app.documents.map((doc) => (
        <DocumentRow key={doc.id} app={app} doc={doc} onChanged={onChanged} />
      ))}

      {mode && (
        <TextArea
          id="decision-reason"
          label={mode === "reject" ? "Why it’s rejected (sent to the vendor)" : MESSAGE_LABEL}
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      )}
      {mode === "reject" && (
        <p className="text-[13px] text-muted">Rejecting is final: the vendor can’t edit or send this application again.</p>
      )}
      <FormError message={error} />

      {(inReview || rejectable) && (
        <div className="flex flex-wrap justify-end gap-2">
          {mode ? (
            <>
              <Button size="md" variant="quiet" disabled={busy} onClick={() => setMode(null)}>
                Back
              </Button>
              <Button size="md" variant="dark" disabled={busy || !reason.trim()} onClick={() => decide(mode === "reject" ? "reject" : "request_changes")}>
                {mode === "reject" ? "Reject application" : "Send request"}
              </Button>
            </>
          ) : (
            <>
              {rejectable && (
                <Button size="md" variant="quiet" onClick={() => setMode("reject")}>
                  Reject
                </Button>
              )}
              {inReview && (
                <>
                  <Button size="md" variant="quiet" onClick={() => setMode("changes")}>
                    Request changes
                  </Button>
                  <Button size="md" disabled={busy || pending} onClick={() => decide("approve")}>
                    Approve &amp; go live
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {inReview && pending && !mode && <span className="text-right text-xs text-muted">Review every document before approving.</span>}
    </section>
  );
}

const APP_TABS: { id: ApplicationTab; label: string; empty: string }[] = [
  { id: "review", label: "Waiting", empty: "Nothing waiting for review." },
  { id: "sent_back", label: "Sent back", empty: "No applications waiting on vendors." },
  { id: "drafts", label: "Not submitted", empty: "No unfinished applications." },
  { id: "rejected", label: "Rejected", empty: "Nothing rejected." },
];

/** The applications in each tab, with counts, and the one selected. */
function ApplicationsView({ review, onReviewChanged }: { review: Application[]; onReviewChanged: () => void }) {
  const [tab, setTab] = useState<ApplicationTab>("review");
  const [selected, setSelected] = useState<string | null>(null);
  const sentBack = useQuery(() => api.getApplications("sent_back"), []);
  const drafts = useQuery(() => api.getApplications("drafts"), []);
  const rejected = useQuery(() => api.getApplications("rejected"), []);
  const lists: Record<ApplicationTab, Application[] | undefined> = { review, sent_back: sentBack.data, drafts: drafts.data, rejected: rejected.data };
  const reloadAll = () => {
    onReviewChanged();
    sentBack.reload();
    drafts.reload();
    rejected.reload();
  };
  const queue = lists[tab] ?? [];
  const current = queue.find((app) => app.outlet.id === selected) ?? queue[0];
  const meta = APP_TABS.find((t) => t.id === tab)!;

  return (
    <>
      <section aria-label="Queue" className="flex flex-none flex-col gap-1 border-b border-[#f0f0f0] p-3 lg:w-80 lg:border-b-0 lg:border-r">
        <div className="flex flex-wrap gap-1.5 px-1 pb-2">
          {APP_TABS.map((t) => (
            <Chip
              key={t.id}
              on={tab === t.id}
              onClick={() => {
                setTab(t.id);
                setSelected(null);
              }}
            >
              {t.label}
              {lists[t.id] ? ` ${lists[t.id]!.length}` : ""}
            </Chip>
          ))}
        </div>
        <span className="px-2 pb-1 text-xs text-muted">{tab === "review" ? "Oldest first" : "Newest first"}</span>
        {!lists[tab] && <p className="px-2 py-4 text-sm text-muted">Loading…</p>}
        {lists[tab] && queue.length === 0 && <p className="px-2 py-4 text-sm text-muted">{meta.empty}</p>}
        {queue.map((app) => {
          const on = app === current;
          return (
            <button
              key={app.outlet.id}
              type="button"
              aria-pressed={on}
              onClick={() => setSelected(app.outlet.id)}
              className={`flex flex-col gap-1 rounded-2xl p-3 text-left ${on ? "bg-tint" : ""}`}
            >
              <strong className="text-sm font-medium">{app.brand.name}</strong>
              <span className="text-xs text-muted">
                {app.outlet.category} · {app.outlet.branchName}
                {app.documents.some((d) => d.status === "rejected") ? " · has flagged files" : ""}
              </span>
            </button>
          );
        })}
      </section>

      {current && <Detail key={current.outlet.id} app={current} onChanged={reloadAll} />}
    </>
  );
}

type Section = "applications" | "vendors" | "inventory" | "admins";
// `short` fits four tabs across a phone.
const SECTIONS: { id: Section; label: string; short: string; superOnly?: true }[] = [
  { id: "applications", label: "Applications", short: "Review" },
  { id: "vendors", label: "Vendors", short: "Vendors" },
  { id: "inventory", label: "Tonight", short: "Tonight" },
  { id: "admins", label: "Admins", short: "Admins", superOnly: true },
];

export default function Admin() {
  const router = useRouter();
  const { me, loading, signOut } = useSession();
  const applications = useQuery(() => api.getApplications(), [me?.id], { enabled: !!me });
  const adminMe = useQuery(() => api.getAdminMe(), [me?.id], { enabled: !!me });
  const [accountOpen, setAccountOpen] = useState(false);
  const [section, go] = useHashTab(
    SECTIONS.map((s) => s.id),
    "applications",
  );

  useEffect(() => {
    if (!loading && !me) router.replace("/signin?next=/admin");
  }, [loading, me, router]);

  if (loading || !me || applications.loading || adminMe.loading) return <PageSkeleton />;

  if (errorStatus(applications.error) === 403) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-2 p-4">
        <h1 className="text-2xl font-bold">Admins only</h1>
        <p className="text-sm text-muted">This account can’t open the review queue.</p>
        <Button
          size="md"
          variant="quiet"
          className="mt-2 self-start"
          onClick={async () => {
            await signOut();
            router.replace("/signin?next=/admin");
          }}
        >
          Log out and switch account
        </Button>
      </div>
    );
  }
  if (applications.error) return <ErrorState message={errorMessage(applications.error)} onRetry={applications.reload} />;

  const queue = applications.data ?? [];
  const isSuper = !!adminMe.data?.isSuperAdmin;
  const sections = SECTIONS.filter((s) => !s.superOnly || isSuper);
  const shown = sections.some((s) => s.id === section) ? section : "applications";
  const logOut = async () => {
    await signOut();
    router.replace("/signin?next=/admin");
  };

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="sticky top-0 hidden h-dvh w-52 flex-none flex-col gap-5 border-r border-[#f0f0f0] p-5 lg:flex">
        <span className="flex items-center gap-2">
          <Logo size="sm" />
          <span className="text-sm text-muted">admin</span>
        </span>
        <nav aria-label="Admin" className="flex flex-col gap-1">
          {sections.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-current={shown === id ? "page" : undefined}
              onClick={() => go(id)}
              className={`flex min-h-11 items-center justify-between rounded-xl px-3 text-left text-sm font-medium ${shown === id ? "bg-dark text-white" : "text-ink"}`}
            >
              {label} {id === "applications" && <span>{queue.length}</span>}
            </button>
          ))}
        </nav>
        {adminMe.data && (
          <div className="mt-auto">
            <ProfileCard me={adminMe.data} onSignOut={logOut} />
          </div>
        )}
      </aside>

      <div className="flex flex-col gap-3 border-b border-[#f0f0f0] p-3 lg:hidden">
        <span className="flex items-center gap-2">
          <Logo size="sm" />
          <span className="text-sm text-muted">admin</span>
          <button
            type="button"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen(!accountOpen)}
            className="ml-auto min-h-10 rounded-full border border-[#dddddd] px-3.5 text-[13px] font-medium"
          >
            Account
          </button>
        </span>
        {accountOpen && adminMe.data && <ProfileCard me={adminMe.data} onSignOut={logOut} />}
        <Tabs value={shown} onChange={go} options={sections.map(({ id, short }) => ({ id, label: short }))} />
      </div>

      {shown === "vendors" && <VendorsView />}
      {shown === "inventory" && <InventoryView />}
      {shown === "admins" && adminMe.data && <AdminsView me={adminMe.data} />}
      {shown === "applications" && <ApplicationsView review={queue} onReviewChanged={applications.reload} />}
    </div>
  );
}
