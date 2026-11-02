import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';
import { env } from '../lib/env.js';
import {
  GatewayRefusedError,
  type GatewayPayment,
  type GatewayRefund,
  type GatewayTransfer,
  type LinkedAccountInput,
  type PaymentGateway,
} from './payments.js';

const API = 'https://api.razorpay.com';
const TIMEOUT_MS = 20_000;
/** The shortest Razorpay allows. Past it a payment stays unused, and any late one goes back to the customer. */
const CAPTURE_MINUTES = 12;

export type RazorpayConfig = { keyId: string; keySecret: string; webhookSecret: string; linkedEmailDomain: string };

type RawPayment = { id: string; order_id: string | null; status: string; amount: number; fee?: number | null; method?: string | null };
type RawTransfer = {
  id: string;
  status: string;
  amount: number;
  amount_reversed?: number;
  on_hold?: boolean;
  notes?: Record<string, string> | unknown[];
};
type Keyed = { id: string; notes?: Record<string, string> | unknown[] };
type Collection<T> = { items: T[] };

/** The parts of the SDK used here. It has no timeouts and drops custom headers, so calls that need a key use fetch. */
export type RazorpayClient = {
  orders: {
    create(params: object): Promise<{ id: string }>;
    fetchPayments(orderId: string): Promise<Collection<RawPayment>>;
  };
  payments: {
    fetch(id: string): Promise<RawPayment>;
    fetchTransfer(id: string): Promise<Collection<RawTransfer>>;
  };
  refunds: { fetch(id: string): Promise<GatewayRefund> };
  transfers: {
    edit(id: string, params: object): Promise<unknown>;
    fetch(id: string): Promise<RawTransfer>;
  };
  accounts: { create(params: object): Promise<{ id: string }> };
  stakeholders: { create(accountId: string, params: object): Promise<unknown> };
  products: {
    requestProductConfiguration(accountId: string, params: object): Promise<{ id: string }>;
    edit(accountId: string, productId: string, params: object): Promise<unknown>;
  };
};

type ApiErrorBody = { code?: unknown; description?: unknown };

/**
 * Only a definite business refusal counts: Razorpay read the request and said no. A status such as
 * 401, 404 or 409 (still in progress) says nothing about the money, and neither does a bad API key,
 * which the docs let come back as any 4xx, so those stay plain and the job tries again.
 */
function errorFrom(label: string, status: number, error: ApiErrorBody | undefined): Error {
  const description = typeof error?.description === 'string' ? error.description : '';
  const refusal =
    (status === 400 || status === 422) && error?.code === 'BAD_REQUEST_ERROR' && !/api key|authentication/i.test(description);
  const message = `Razorpay ${label} answered ${status}: ${description || 'no description'}`;
  return refusal ? new GatewayRefusedError(message) : new Error(message);
}

/** What Razorpay allows in an idempotency header: 10 or more for refunds, 4 to 36 for transfers, no colons. */
const headerKey = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 32);

const hasKey = (item: Keyed, key: string) => !Array.isArray(item.notes) && item.notes?.idempotency_key === key;

const PAYMENT_STATUSES: Record<string, GatewayPayment['status']> = {
  // Nothing has happened yet, which to this app is the same as waiting on a capture.
  created: 'authorized',
  authorized: 'authorized',
  captured: 'captured',
  failed: 'failed',
  refunded: 'refunded',
};

function toPayment(p: RawPayment): GatewayPayment {
  const status = PAYMENT_STATUSES[p.status];
  if (!status) throw new Error(`Payment ${p.id} has unknown status ${p.status}`);
  return {
    id: p.id,
    // A payment made without an order has none. Nothing here matches an empty ID, so it is recorded as unknown.
    orderId: p.order_id ?? '',
    status,
    amountPaise: p.amount,
    feePaise: p.fee ?? null,
    method: p.method ?? null,
  };
}

/** What is left of a transfer. A failed one never moved money, so nothing is left of it. */
function toTransfer(t: RawTransfer): GatewayTransfer {
  const amountPaise = t.status === 'failed' ? 0 : t.amount - (t.amount_reversed ?? 0);
  return {
    id: t.id,
    amountPaise,
    status: amountPaise <= 0 ? 'reversed' : t.on_hold ? 'on_hold' : 'released',
  };
}

/** The states of the launch cities. Razorpay requires one and the app holds only the city. */
const STATES: Record<string, string> = { bengaluru: 'KARNATAKA', hyderabad: 'TELANGANA' };

/** The fourth letter of a PAN says what holds it. Nothing else here says how a vendor is set up. */
const BUSINESS_TYPES: Record<string, string> = { P: 'proprietorship', C: 'private_limited', F: 'partnership', T: 'trust' };
const INDIVIDUAL_PAN = 'P';

function registeredAddress({ address }: LinkedAccountInput) {
  const { street, city, postalCode } = address;
  if (!street || !city || !postalCode) throw new Error('A linked account needs a full address');
  const state = STATES[city];
  if (!state) throw new Error(`No state known for ${city}`);
  return { street1: street.slice(0, 100), city, state, postal_code: postalCode, country: 'IN' };
}

export class RazorpayGateway implements PaymentGateway {
  readonly keyId: string;

  constructor(
    private readonly config: RazorpayConfig,
    private readonly client: RazorpayClient = new Razorpay({
      key_id: config.keyId,
      key_secret: config.keySecret,
    }) as unknown as RazorpayClient,
  ) {
    for (const [name, value] of Object.entries(config)) {
      if (!value) throw new Error(`Razorpay is missing ${name}`);
    }
    this.keyId = config.keyId;
  }

  /** A call through the SDK, held to the same timeout and error rules as the rest. */
  private async sdk<T>(label: string, call: (client: RazorpayClient) => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Razorpay ${label} timed out`)), TIMEOUT_MS);
    });
    try {
      return await Promise.race([call(this.client), timeout]);
    } catch (e) {
      const failure = e as { statusCode?: unknown; error?: ApiErrorBody };
      throw typeof failure.statusCode === 'number' ? errorFrom(label, failure.statusCode, failure.error) : e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(method: string, path: string, body?: object, headers: Record<string, string> = {}): Promise<T> {
    const label = `${method} ${path}`;
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json', ...headers },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!res.ok) throw errorFrom(label, res.status, (parsed as { error?: ApiErrorBody } | undefined)?.error);
    if (parsed === undefined) throw new Error(`Razorpay ${label} gave an unreadable answer`);
    return parsed as T;
  }

  createOrder(a: { amountPaise: number; receipt: string }): Promise<{ id: string }> {
    return this.sdk('create order', (c) =>
      c.orders.create({
        amount: a.amountPaise,
        currency: 'INR',
        receipt: a.receipt,
        payment: {
          capture: 'automatic',
          capture_options: {
            automatic_expiry_period: CAPTURE_MINUTES,
            manual_expiry_period: CAPTURE_MINUTES,
            refund_speed: 'normal',
          },
        },
      }),
    );
  }

  async fetchPayment(id: string): Promise<GatewayPayment> {
    return toPayment(await this.sdk('fetch payment', (c) => c.payments.fetch(id)));
  }

  async listOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    const { items } = await this.sdk('list order payments', (c) => c.orders.fetchPayments(orderId));
    return items.map(toPayment);
  }

  async refund(a: { paymentId: string; amountPaise: number; reverseTransfer: boolean; idempotencyKey: string }): Promise<GatewayRefund> {
    const { id, status } = await this.request<GatewayRefund>(
      'POST',
      `/v1/payments/${a.paymentId}/refund`,
      { amount: a.amountPaise, ...(a.reverseTransfer ? { reverse_all: true } : {}) },
      { 'X-Refund-Idempotency': headerKey(a.idempotencyKey) },
    );
    return { id, status };
  }

  async fetchRefund(id: string): Promise<GatewayRefund> {
    const refund = await this.sdk('fetch refund', (c) => c.refunds.fetch(id));
    return { id: refund.id, status: refund.status };
  }

  private async rawTransfers(paymentId: string): Promise<RawTransfer[]> {
    return (await this.sdk('list payment transfers', (c) => c.payments.fetchTransfer(paymentId))).items;
  }

  /**
   * The docs give an idempotency header only for direct transfers, not these, so the header is sent
   * and not relied on: the key also goes in the notes, and a retry looks for it there first.
   */
  async createTransfer(a: { paymentId: string; accountId: string; amountPaise: number; idempotencyKey: string }): Promise<{ id: string }> {
    const made = (await this.rawTransfers(a.paymentId)).find((t) => hasKey(t, a.idempotencyKey) && t.status !== 'failed');
    if (made) return { id: made.id };

    const { items } = await this.request<Collection<RawTransfer>>(
      'POST',
      `/v1/payments/${a.paymentId}/transfers`,
      {
        transfers: [
          { account: a.accountId, amount: a.amountPaise, currency: 'INR', on_hold: true, notes: { idempotency_key: a.idempotencyKey } },
        ],
      },
      { 'X-Transfer-Idempotency': headerKey(a.idempotencyKey) },
    );
    const transfer = items?.[0];
    if (!transfer) throw new Error(`Razorpay gave no transfer for payment ${a.paymentId}`);
    return { id: transfer.id };
  }

  /** A refusal is no failure if the hold is already off: releasing twice is harmless. */
  async releaseTransfer(id: string): Promise<void> {
    try {
      await this.sdk('release transfer', (c) => c.transfers.edit(id, { on_hold: false }));
    } catch (e) {
      if (!(e instanceof GatewayRefusedError)) throw e;
      if (toTransfer(await this.sdk('fetch transfer', (c) => c.transfers.fetch(id))).status !== 'released') throw e;
    }
  }

  /** Keyed as createTransfer is. If the earlier reversals cannot be read, nothing is sent. */
  async reverseTransferPartial(transferId: string, amountPaise: number, idempotencyKey: string): Promise<{ id: string }> {
    const path = `/v1/transfers/${transferId}/reversals`;
    const { items } = await this.request<Collection<Keyed>>('GET', path);
    const made = items?.find((r) => hasKey(r, idempotencyKey));
    if (made) return { id: made.id };

    const { id } = await this.request<Keyed>(
      'POST',
      path,
      { amount: amountPaise, notes: { idempotency_key: idempotencyKey } },
      { 'X-Transfer-Idempotency': headerKey(idempotencyKey) },
    );
    return { id };
  }

  async listPaymentTransfers(paymentId: string): Promise<GatewayTransfer[]> {
    return (await this.rawTransfers(paymentId)).map(toTransfer);
  }

  /**
   * The account, its stakeholder, then Route with the bank details. A bank change makes a new account,
   * and Razorpay refuses an email it has seen, so each gets a fresh address of ours whatever the
   * vendor's is. A failure part way leaves a dead account there, and the retry starts a new one.
   */
  async createLinkedAccount(a: LinkedAccountInput): Promise<{ id: string }> {
    const registered = registeredAddress(a);
    const email = `linked+${a.referenceId}.${randomBytes(4).toString('hex')}@${this.config.linkedEmailDomain}`;
    const panHolder = a.pan.charAt(3).toUpperCase();
    const proprietor = panHolder === INDIVIDUAL_PAN;

    const { id } = await this.sdk('create linked account', (c) =>
      c.accounts.create({
        email,
        phone: a.phone.replace(/^\+91/, ''),
        type: 'route',
        legal_business_name: a.legalName,
        business_type: BUSINESS_TYPES[panHolder] ?? 'other',
        contact_name: a.contactName,
        profile: { category: 'food', subcategory: 'restaurant', addresses: { registered } },
        // Razorpay takes only a business PAN here. A proprietor's is their own, on the stakeholder.
        ...(proprietor ? {} : { legal_info: { pan: a.pan } }),
      }),
    );
    await this.sdk('create stakeholder', (c) =>
      c.stakeholders.create(id, { name: a.contactName, email, ...(proprietor ? { kyc: { pan: a.pan } } : {}) }),
    );
    const product = await this.sdk('request route', (c) =>
      c.products.requestProductConfiguration(id, { product_name: 'route', tnc_accepted: true }),
    );
    await this.sdk('configure route', (c) =>
      c.products.edit(id, product.id, {
        settlements: { account_number: a.accountNumber, ifsc_code: a.ifsc, beneficiary_name: a.holderName },
        tnc_accepted: true,
      }),
    );
    return { id };
  }

  /** The signature is a hex HMAC-SHA256 of the raw body, compared in constant time. */
  verifyWebhook(raw: string, signature: string): boolean {
    if (!signature) return false;
    const expected = Buffer.from(createHmac('sha256', this.config.webhookSecret).update(raw).digest('hex'));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}

export function razorpayFromEnv(): RazorpayGateway {
  const e = env();
  return new RazorpayGateway({
    keyId: e.RAZORPAY_KEY_ID ?? '',
    keySecret: e.RAZORPAY_KEY_SECRET ?? '',
    webhookSecret: e.RAZORPAY_WEBHOOK_SECRET ?? '',
    linkedEmailDomain: e.RAZORPAY_LINKED_EMAIL_DOMAIN ?? '',
  });
}
