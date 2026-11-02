"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FormError, TextArea } from "@/components/forms";
import { Button, ErrorState, Logo, PageSkeleton, StatusChip } from "@/components/ui";
import { api, errorDetails, errorMessage, errorStatus, type Application, type ReviewedDocument } from "@/lib/api";
import { shortDate } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
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
          <StatusChip tone={status.tone}>{status.label}</StatusChip>
        )}
      </div>
      {flagging && reviewable && (
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

function Detail({ app, onChanged }: { app: Application; onChanged: () => void }) {
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = app.documents.some((doc) => doc.status === "pending");
  const { outlet } = app;

  async function decide(decision: "approve" | "request_changes") {
    setBusy(true);
    setError(null);
    try {
      await api.decideOutlet(outlet.id, { decision, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      onChanged();
    } catch (err) {
      const fixes = errorDetails(err).fixes?.map((fix) => fix.message).join(". ");
      setError(fixes || errorMessage(err));
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
            {outlet.submittedAt ? ` · applied ${shortDate(outlet.submittedAt)}` : ""}
          </span>
        </div>
        <StatusChip tone="wait">Under review</StatusChip>
      </div>

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
      {app.documents.map((doc) => (
        <DocumentRow key={doc.id} app={app} doc={doc} onChanged={onChanged} />
      ))}

      {asking && <TextArea id="changes" label="Message to vendor (sent on WhatsApp and shown on their status screen)" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />}
      <FormError message={error} />

      <div className="flex flex-wrap justify-end gap-2">
        {asking ? (
          <Button size="md" variant="quiet" disabled={busy || !reason.trim()} onClick={() => decide("request_changes")}>
            Send request
          </Button>
        ) : (
          <Button size="md" variant="quiet" onClick={() => setAsking(true)}>
            Request changes
          </Button>
        )}
        <Button size="md" disabled={busy || pending} onClick={() => decide("approve")}>
          Approve &amp; go live
        </Button>
      </div>
      {pending && <span className="text-right text-xs text-muted">Review every document before approving.</span>}
    </section>
  );
}

export default function Admin() {
  const router = useRouter();
  const { me, loading } = useSession();
  const applications = useQuery(() => api.getApplications(), [me?.id], { enabled: !!me });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !me) router.replace("/signin?next=/admin");
  }, [loading, me, router]);

  if (loading || !me || applications.loading) return <PageSkeleton />;

  if (errorStatus(applications.error) === 403) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-2 p-4">
        <h1 className="text-2xl font-bold">Admins only</h1>
        <p className="text-sm text-muted">This account can’t open the review queue.</p>
      </div>
    );
  }
  if (applications.error) return <ErrorState message={errorMessage(applications.error)} onRetry={applications.reload} />;

  const queue = applications.data ?? [];
  const current = queue.find((app) => app.outlet.id === selected) ?? queue[0];

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="hidden w-52 flex-none flex-col gap-5 border-r border-[#f0f0f0] p-5 lg:flex">
        <span className="flex items-center gap-2">
          <Logo size="sm" />
          <span className="text-sm text-muted">admin</span>
        </span>
        <nav aria-label="Admin">
          <span aria-current="page" className="flex min-h-11 items-center justify-between rounded-xl bg-dark px-3 text-sm font-medium text-white">
            Applications <span>{queue.length}</span>
          </span>
        </nav>
      </aside>

      <section aria-label="Queue" className="flex flex-none flex-col gap-1 border-b border-[#f0f0f0] p-3 lg:w-80 lg:border-b-0 lg:border-r">
        <div className="flex items-baseline justify-between px-2 py-2">
          <strong className="text-[15px] font-medium">Application queue</strong>
          <span className="text-xs text-muted">oldest first</span>
        </div>
        {queue.length === 0 && <p className="px-2 py-4 text-sm text-muted">Nothing waiting for review.</p>}
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
              </span>
            </button>
          );
        })}
      </section>

      {current && <Detail key={current.outlet.id} app={current} onChanged={applications.reload} />}
    </div>
  );
}
