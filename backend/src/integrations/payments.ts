export type GatewayPayment = {
  id: string;
  /** The Razorpay order this payment belongs to. */
  orderId: string;
  status: 'authorized' | 'captured' | 'failed' | 'refunded';
  amountPaise: number;
  feePaise: number | null;
  method: string | null;
};

export type LinkedAccountInput = {
  legalName: string;
  holderName: string;
  accountNumber: string;
  ifsc: string;
};

export type GatewayRefund = { id: string; status: string };

/** The gateway definitely said no. Anything else thrown by a refund call leaves the outcome unknown. */
export class GatewayRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayRefusedError';
  }
}

export interface PaymentGateway {
  keyId: string;
  createOrder(a: { amountPaise: number; receipt: string }): Promise<{ id: string }>;
  fetchPayment(id: string): Promise<GatewayPayment>;
  listOrderPayments(orderId: string): Promise<GatewayPayment[]>;
  /** Throws GatewayRefusedError on a definite refusal. A network error, timeout or 5xx throws anything else. */
  refund(a: {
    paymentId: string;
    amountPaise: number;
    reverseTransfer: boolean;
    idempotencyKey: string;
  }): Promise<GatewayRefund>;
  fetchRefund(id: string): Promise<GatewayRefund>;
  createTransfer(a: { paymentId: string; accountId: string; amountPaise: number }): Promise<{ id: string }>;
  releaseTransfer(id: string): Promise<void>;
  createLinkedAccount(a: LinkedAccountInput): Promise<{ id: string }>;
  verifyWebhook(raw: string, signature: string): boolean;
}

/** Keeps everything in memory. Used by tests and local development. */
export class FakeGateway implements PaymentGateway {
  readonly keyId = 'rzp_test_fake';
  readonly orders: { id: string; amountPaise: number; receipt: string }[] = [];
  readonly payments = new Map<string, GatewayPayment>();
  /** Payment IDs passed to fetchPayment, and order IDs passed to listOrderPayments. */
  readonly fetches: string[] = [];
  readonly listed: string[] = [];
  readonly refunds: {
    id: string;
    paymentId: string;
    amountPaise: number;
    reverseTransfer: boolean;
    idempotencyKey: string;
    status: string;
  }[] = [];
  /** Refund IDs passed to fetchRefund. */
  readonly refundFetches: string[] = [];
  /** The status new refunds get. */
  refundStatus = 'pending';
  /** How many coming refunds are accepted, but answered with a timeout. */
  timeoutsAfterAccept = 0;
  readonly transfers: { id: string; paymentId: string; accountId: string; amountPaise: number; released: boolean }[] = [];
  readonly linkedAccounts: (LinkedAccountInput & { id: string })[] = [];

  /** Adds a payment, or replaces the one with this ID. */
  addPayment(p: GatewayPayment): GatewayPayment {
    this.payments.set(p.id, p);
    return p;
  }

  async createOrder(a: { amountPaise: number; receipt: string }): Promise<{ id: string }> {
    const order = { id: `order_fake_${this.orders.length + 1}`, ...a };
    this.orders.push(order);
    return { id: order.id };
  }

  async fetchPayment(id: string): Promise<GatewayPayment> {
    this.fetches.push(id);
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake payment ${id}`);
    return payment;
  }

  async listOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    this.listed.push(orderId);
    return [...this.payments.values()].filter((p) => p.orderId === orderId);
  }

  async refund(a: {
    paymentId: string;
    amountPaise: number;
    reverseTransfer: boolean;
    idempotencyKey: string;
  }): Promise<GatewayRefund> {
    // Like Razorpay, a key already seen gets the same refund back.
    const sent = this.refunds.find((r) => r.idempotencyKey === a.idempotencyKey);
    if (sent) return { id: sent.id, status: sent.status };

    // Payments this fake was never told about have no known amount, so only known ones are checked.
    const payment = this.payments.get(a.paymentId);
    const refunded = this.refunds
      .filter((r) => r.paymentId === a.paymentId && r.status !== 'failed')
      .reduce((total, r) => total + r.amountPaise, 0);
    if (payment && refunded + a.amountPaise > payment.amountPaise) {
      throw new GatewayRefusedError(`Refund exceeds what is left of payment ${a.paymentId}`);
    }

    const refund = { id: `rfnd_fake_${this.refunds.length + 1}`, status: this.refundStatus, ...a };
    this.refunds.push(refund);
    if (this.timeoutsAfterAccept > 0) {
      this.timeoutsAfterAccept--;
      throw new Error('Gateway timed out');
    }
    return { id: refund.id, status: refund.status };
  }

  async fetchRefund(id: string): Promise<GatewayRefund> {
    this.refundFetches.push(id);
    const refund = this.refunds.find((r) => r.id === id);
    if (!refund) throw new Error(`No fake refund ${id}`);
    return { id: refund.id, status: refund.status };
  }

  /** Moves a refund on, as the gateway would in its own time. */
  setRefundStatus(id: string, status: string): void {
    const refund = this.refunds.find((r) => r.id === id);
    if (!refund) throw new Error(`No fake refund ${id}`);
    refund.status = status;
  }

  async createTransfer(a: { paymentId: string; accountId: string; amountPaise: number }): Promise<{ id: string }> {
    const transfer = { id: `trf_fake_${this.transfers.length + 1}`, released: false, ...a };
    this.transfers.push(transfer);
    return { id: transfer.id };
  }

  async releaseTransfer(id: string): Promise<void> {
    const transfer = this.transfers.find((t) => t.id === id);
    if (!transfer) throw new Error(`No fake transfer ${id}`);
    transfer.released = true;
  }

  async createLinkedAccount(a: LinkedAccountInput): Promise<{ id: string }> {
    const account = { id: `acc_fake_${this.linkedAccounts.length + 1}`, ...a };
    this.linkedAccounts.push(account);
    return { id: account.id };
  }

  verifyWebhook(_raw: string, signature: string): boolean {
    return signature === 'valid';
  }
}

let gateway: PaymentGateway | undefined;

/** The fake accepts any `valid` signature, so production refuses to start one. Task 18 adds the real adapter. */
export function getGateway(): PaymentGateway {
  if (gateway) return gateway;
  if (process.env.NODE_ENV === 'production') throw new Error('No payment gateway configured');
  gateway = new FakeGateway();
  return gateway;
}

export function setGateway(g: PaymentGateway): void {
  gateway = g;
}
