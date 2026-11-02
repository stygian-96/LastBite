import { afterEach, describe, expect, test, vi } from 'vitest';
import { GatewayRefusedError, type LinkedAccountInput, type LinkProgress } from '../../src/integrations/payments.js';
import { RazorpayGateway, type RazorpayClient } from '../../src/integrations/razorpay.js';

const CONFIG = {
  keyId: 'rzp_test_key',
  keySecret: 'key-secret',
  webhookSecret: 'webhook-secret',
  linkedEmailDomain: 'payouts.example.com',
};
const BODY = '{"event":"payment.captured"}';
// HMAC-SHA256 of BODY under 'webhook-secret', worked out outside this code.
const SIGNATURE = '0e95258623492dd0dae77245c958c256d46b4a30b338084b7e996fc25653c79c';

const refused = { error: { code: 'BAD_REQUEST_ERROR', description: 'The total refund amount is greater than the payment' } };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Sent = { url: string; init: RequestInit };

/** Answers each fetch in turn, and records what was asked. */
function stubFetch(...answers: (Response | Error)[]): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      const answer = answers.shift();
      if (!answer) throw new Error(`Unexpected fetch of ${url}`);
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  );
  return sent;
}

const header = (s: Sent, name: string) => new Headers(s.init.headers).get(name);
const sentBody = (s: Sent) => JSON.parse(s.init.body as string) as Record<string, unknown>;

type Params = Record<string, unknown>;
type Stub = { [K in keyof RazorpayClient]?: Partial<RazorpayClient[K]> };

/** A stand-in for the SDK, with only the methods a test gives it. Nothing here reaches the network. */
const gateway = (c: Stub = {}) => new RazorpayGateway(CONFIG, c as RazorpayClient);

/** The empty list a retry-safe call reads before it sends anything. */
const nothingYet = () => json(200, { entity: 'collection', count: 0, items: [] });

const REFUND = { paymentId: 'pay_1', amountPaise: 5000, reverseTransfer: true, idempotencyKey: 'refund-1-0' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('verifyWebhook', () => {
  test('Razorpay verifyWebhook matches a known HMAC of the raw body', () => {
    expect(gateway().verifyWebhook(BODY, SIGNATURE)).toBe(true);
  });

  test('refuses a changed body, a wrong or short signature, and an empty one', () => {
    const g = gateway();
    expect(g.verifyWebhook(`${BODY} `, SIGNATURE)).toBe(false);
    expect(g.verifyWebhook(BODY, 'a'.repeat(64))).toBe(false);
    expect(g.verifyWebhook(BODY, 'abc')).toBe(false);
    expect(g.verifyWebhook(BODY, '')).toBe(false);
  });
});

describe('setup', () => {
  test.each(['keyId', 'keySecret', 'webhookSecret', 'linkedEmailDomain'] as const)('refuses to start without %s', (name) => {
    expect(() => new RazorpayGateway({ ...CONFIG, [name]: '' }, {} as RazorpayClient)).toThrow(name);
  });
});

describe('error mapping', () => {
  test('a 400 business refusal becomes GatewayRefusedError', async () => {
    stubFetch(nothingYet(), json(400, refused));
    await expect(gateway().refund(REFUND)).rejects.toBeInstanceOf(GatewayRefusedError);
  });

  test('a 422 business refusal becomes GatewayRefusedError', async () => {
    stubFetch(nothingYet(), json(422, refused));
    await expect(gateway().refund(REFUND)).rejects.toBeInstanceOf(GatewayRefusedError);
  });

  test.each([
    ['a 500', () => json(500, { error: { code: 'SERVER_ERROR', description: 'We are facing some trouble' } })],
    ['a 502', () => json(502, { error: { code: 'GATEWAY_ERROR', description: 'Bank down' } })],
    ['a 503 with no JSON', () => new Response('<html>busy</html>', { status: 503 })],
    ['a 401', () => json(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } })],
    ['a 404', () => json(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'The requested URL was not found' } })],
    ['a 409, still in progress', () => json(409, { error: { code: 'BAD_REQUEST_ERROR', description: 'Request in progress' } })],
    ['a 429', () => json(429, { error: { code: 'BAD_REQUEST_ERROR', description: 'Too many requests' } })],
    ['a 400 about the idempotency key', () => json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Different request body sent for the same Idempotency Header' } })],
    ['a 400 saying it is in progress', () => json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Refund is in progress' } })],
    ['a 400 about the API key', () => json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The api key provided is invalid' } })],
    ['a 400 that is not a business error', () => json(400, { error: { code: 'SERVER_ERROR', description: 'Odd' } })],
    ['a 400 with no JSON', () => new Response('Bad Request', { status: 400 })],
  ])('%s stays a plain error', async (_name, answer) => {
    stubFetch(nothingYet(), answer());
    const failure = await gateway().refund(REFUND).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(GatewayRefusedError);
  });

  test('a network failure stays a plain error', async () => {
    stubFetch(nothingYet(), new TypeError('fetch failed'));
    const failure = await gateway().refund(REFUND).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TypeError);
  });

  test('every direct request carries a timeout under 30 seconds', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    stubFetch(nothingYet(), json(200, { id: 'rfnd_1', status: 'pending' }));
    await gateway().refund(REFUND);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [ms] of spy.mock.calls) expect(ms).toBeLessThan(30_000);
    spy.mockRestore();
  });

  test('an SDK call is held to the same timeout, and a timeout is plain', async () => {
    vi.useFakeTimers();
    const g = gateway({ payments: { fetch: () => new Promise(() => {}) } });
    const failure = g.fetchPayment('pay_1').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    const e = await failure;
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(GatewayRefusedError);
  });

  test('the SDK error shape maps the same way', async () => {
    const rejecting = (statusCode: number) => ({
      refunds: { fetch: () => Promise.reject({ statusCode, error: refused.error }) },
    });
    await expect(gateway(rejecting(400)).fetchRefund('r')).rejects.toBeInstanceOf(GatewayRefusedError);
    const server = await gateway(rejecting(500)).fetchRefund('r').catch((e: unknown) => e);
    expect(server).toBeInstanceOf(Error);
    expect(server).not.toBeInstanceOf(GatewayRefusedError);
  });
});

describe('createOrder', () => {
  test('asks for automatic capture, in INR', async () => {
    const create = vi.fn<(params: object) => Promise<{ id: string }>>(async () => ({ id: 'order_1' }));
    expect(await gateway({ orders: { create } }).createOrder({ amountPaise: 14900, receipt: 'r1' })).toEqual({ id: 'order_1' });
    expect(create).toHaveBeenCalledWith({
      amount: 14900,
      currency: 'INR',
      receipt: 'r1',
      payment: {
        capture: 'automatic',
        capture_options: { automatic_expiry_period: 12, manual_expiry_period: 12, refund_speed: 'normal' },
      },
    });
  });
});

describe('payments', () => {
  const raw = { id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 14900, fee: 352, method: 'upi' };

  test('maps a payment', async () => {
    const g = gateway({ payments: { fetch: async () => raw } });
    expect(await g.fetchPayment('pay_1')).toEqual({
      id: 'pay_1',
      orderId: 'order_1',
      status: 'captured',
      amountPaise: 14900,
      feePaise: 352,
      method: 'upi',
    });
  });

  test('a payment with no order_id and no fee yet does not break the mapping', async () => {
    const g = gateway({ payments: { fetch: async () => ({ ...raw, order_id: null, fee: null, method: null }) } });
    expect(await g.fetchPayment('pay_1')).toMatchObject({ orderId: '', feePaise: null, method: null });
  });

  test('created reads as not final, never as failed', async () => {
    const g = gateway({ payments: { fetch: async () => ({ ...raw, status: 'created' }) } });
    expect((await g.fetchPayment('pay_1')).status).toBe('authorized');
  });

  test('a status it does not know is an error, not a guess', async () => {
    const g = gateway({ payments: { fetch: async () => ({ ...raw, status: 'mystery' }) } });
    await expect(g.fetchPayment('pay_1')).rejects.toThrow('mystery');
  });

  test('lists the payments of an order', async () => {
    const g = gateway({ orders: { fetchPayments: async () => ({ items: [raw] }) } });
    expect((await g.listOrderPayments('order_1')).map((p) => p.id)).toEqual(['pay_1']);
  });
});

describe('refund', () => {
  test('posts with the idempotency header, and reverses only when asked', async () => {
    const sent = stubFetch(
      nothingYet(),
      json(200, { id: 'rfnd_1', status: 'pending' }),
      nothingYet(),
      json(200, { id: 'rfnd_2', status: 'processed' }),
    );
    const g = gateway();
    expect(await g.refund(REFUND)).toEqual({ id: 'rfnd_1', status: 'pending' });
    await g.refund({ ...REFUND, reverseTransfer: false, idempotencyKey: 'refund-2-0' });

    expect(sent[1]!.url).toBe('https://api.razorpay.com/v1/payments/pay_1/refund');
    expect(sent[1]!.init.method).toBe('POST');
    expect(header(sent[1]!, 'authorization')).toBe(`Basic ${Buffer.from('rzp_test_key:key-secret').toString('base64')}`);
    expect(sentBody(sent[1]!)).toEqual({ amount: 5000, reverse_all: true, notes: { idempotency_key: REFUND.idempotencyKey } });
    expect(sentBody(sent[3]!)).toEqual({ amount: 5000, notes: { idempotency_key: 'refund-2-0' } });
  });

  test('a key already on the payment gets that refund back, with nothing sent', async () => {
    const seen = { id: 'rfnd_old', status: 'pending', notes: { idempotency_key: REFUND.idempotencyKey } };
    const other = { id: 'rfnd_other', status: 'processed', notes: { idempotency_key: 'another' } };
    const sent = stubFetch(json(200, { items: [other, seen] }));
    expect(await gateway().refund(REFUND)).toEqual({ id: 'rfnd_old', status: 'pending' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.init.method).toBe('GET');
    expect(sent[0]!.url).toContain('/v1/payments/pay_1/refunds');
  });

  test('a refund with empty notes, as Razorpay writes them, is not a match', async () => {
    const sent = stubFetch(json(200, { items: [{ id: 'rfnd_old', status: 'pending', notes: [] }] }), json(200, { id: 'rfnd_1', status: 'pending' }));
    expect((await gateway().refund(REFUND)).id).toBe('rfnd_1');
    expect(sent).toHaveLength(2);
  });

  test.each([
    ['a 500', () => json(500, {})],
    ['a 400', () => json(400, refused)],
  ])('a list of refunds answering %s sends nothing, and is no refusal', async (_name, answer) => {
    const sent = stubFetch(answer());
    const failure = await gateway().refund(REFUND).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(GatewayRefusedError);
    expect(sent).toHaveLength(1);
  });

  test('the same key sends the same header, shaped as Razorpay allows, and a long key fits', async () => {
    const long = `${'a'.repeat(36)}-3`;
    const sent = stubFetch(...[1, 2, 3].flatMap(() => [nothingYet(), json(200, { id: 'rfnd_1', status: 'pending' })]));
    const g = gateway();
    await g.refund({ ...REFUND, idempotencyKey: long });
    await g.refund({ ...REFUND, idempotencyKey: long });
    await g.refund({ ...REFUND, idempotencyKey: `${long}x` });
    const keys = sent.filter((s) => s.init.method === 'POST').map((s) => header(s, 'x-refund-idempotency')!);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[0]).toMatch(/^[a-f0-9]{10,36}$/);
  });

  test('fetches a refund', async () => {
    const g = gateway({ refunds: { fetch: async () => ({ id: 'rfnd_1', status: 'processed' }) } });
    expect(await g.fetchRefund('rfnd_1')).toEqual({ id: 'rfnd_1', status: 'processed' });
  });
});

const TRANSFER = { paymentId: 'pay_1', accountId: 'acc_1', amountPaise: 9000, idempotencyKey: `transfer-${'b'.repeat(36)}` };

const rawTransfer = (o: object = {}) => ({
  id: 'trf_1',
  status: 'processed',
  amount: 9000,
  amount_reversed: 0,
  on_hold: true,
  notes: {},
  ...o,
});

describe('transfers', () => {
  test('createTransfer holds it, keys it, and returns what Razorpay made', async () => {
    const g = gateway({ payments: { fetchTransfer: async () => ({ items: [] }) } });
    const sent = stubFetch(json(200, { entity: 'collection', count: 1, items: [rawTransfer({ id: 'trf_9' })] }));
    expect(await g.createTransfer(TRANSFER)).toEqual({ id: 'trf_9' });
    expect(sent[0]!.url).toBe('https://api.razorpay.com/v1/payments/pay_1/transfers');
    expect(sentBody(sent[0]!)).toEqual({
      transfers: [{ account: 'acc_1', amount: 9000, currency: 'INR', on_hold: true, notes: { idempotency_key: TRANSFER.idempotencyKey } }],
    });
    expect(header(sent[0]!, 'x-transfer-idempotency')).toMatch(/^[a-f0-9]{4,36}$/);
  });

  test('a key already seen on the payment gets that transfer back, with nothing sent', async () => {
    const items = [rawTransfer({ id: 'trf_old', notes: { idempotency_key: TRANSFER.idempotencyKey } })];
    const g = gateway({ payments: { fetchTransfer: async () => ({ items }) } });
    const sent = stubFetch();
    expect(await g.createTransfer(TRANSFER)).toEqual({ id: 'trf_old' });
    expect(sent).toEqual([]);
  });

  test('a failed transfer under the key does not count as already made', async () => {
    const items = [rawTransfer({ id: 'trf_bad', status: 'failed', notes: { idempotency_key: TRANSFER.idempotencyKey } })];
    const g = gateway({ payments: { fetchTransfer: async () => ({ items }) } });
    stubFetch(json(200, { items: [rawTransfer({ id: 'trf_new' })] }));
    expect(await g.createTransfer(TRANSFER)).toEqual({ id: 'trf_new' });
  });

  test('createTransfer with no transfer in the answer is an error', async () => {
    const g = gateway({ payments: { fetchTransfer: async () => ({ items: [] }) } });
    stubFetch(json(200, { items: [] }));
    await expect(g.createTransfer(TRANSFER)).rejects.toThrow('no transfer');
  });

  test.each([
    ['held in full', rawTransfer(), { amountPaise: 9000, status: 'on_hold' }],
    ['released', rawTransfer({ on_hold: false }), { amountPaise: 9000, status: 'released' }],
    ['partly reversed, reports what is left', rawTransfer({ status: 'partially_reversed', amount_reversed: 2500 }), { amountPaise: 6500, status: 'on_hold' }],
    ['partly reversed and released', rawTransfer({ status: 'partially_reversed', amount_reversed: 2500, on_hold: false }), { amountPaise: 6500, status: 'released' }],
    ['reversed in full', rawTransfer({ status: 'reversed', amount_reversed: 9000 }), { amountPaise: 0, status: 'reversed' }],
    ['failed, so nothing moved', rawTransfer({ status: 'failed' }), { amountPaise: 0, status: 'reversed' }],
    ['pending, still held', rawTransfer({ status: 'pending' }), { amountPaise: 9000, status: 'on_hold' }],
  ])('listPaymentTransfers: %s', async (_name, raw, expected) => {
    const g = gateway({ payments: { fetchTransfer: async () => ({ items: [raw] }) } });
    expect(await g.listPaymentTransfers('pay_1')).toEqual([{ id: 'trf_1', ...expected }]);
  });

  test('releaseTransfer takes the hold off', async () => {
    const edit = vi.fn(async () => ({}));
    await gateway({ transfers: { edit } }).releaseTransfer('trf_1');
    expect(edit).toHaveBeenCalledWith('trf_1', { on_hold: false });
  });

  test('releasing twice is harmless: a refusal on a transfer already released is no failure', async () => {
    const g = gateway({
      transfers: {
        edit: () => Promise.reject({ statusCode: 400, error: refused.error }),
        fetch: async () => rawTransfer({ on_hold: false }),
      },
    });
    await expect(g.releaseTransfer('trf_1')).resolves.toBeUndefined();
  });

  test('a refusal on a transfer that was not released stands', async () => {
    const g = gateway({
      transfers: {
        edit: () => Promise.reject({ statusCode: 400, error: refused.error }),
        fetch: async () => rawTransfer({ status: 'reversed', amount_reversed: 9000 }),
      },
    });
    await expect(g.releaseTransfer('trf_1')).rejects.toBeInstanceOf(GatewayRefusedError);
  });

  test('reverseTransferPartial posts the amount, keyed', async () => {
    const sent = stubFetch(json(200, { items: [] }), json(200, { id: 'rvrsl_1', transfer_id: 'trf_1', amount: 2500 }));
    const key = `reversal-${'c'.repeat(36)}-${'d'.repeat(36)}`;
    expect(await gateway().reverseTransferPartial('trf_1', 2500, key)).toEqual({ id: 'rvrsl_1' });
    expect(sent[0]!.url).toBe('https://api.razorpay.com/v1/transfers/trf_1/reversals');
    expect(sent[0]!.init.method).toBe('GET');
    expect(sent[1]!.init.method).toBe('POST');
    expect(sentBody(sent[1]!)).toEqual({ amount: 2500, notes: { idempotency_key: key } });
    expect(header(sent[1]!, 'x-transfer-idempotency')).toMatch(/^[a-f0-9]{4,36}$/);
  });

  test('a reversal key already seen gets that reversal back, with nothing sent', async () => {
    const sent = stubFetch(json(200, { items: [{ id: 'rvrsl_old', notes: { idempotency_key: 'k-1' } }] }));
    expect(await gateway().reverseTransferPartial('trf_1', 2500, 'k-1')).toEqual({ id: 'rvrsl_old' });
    expect(sent).toHaveLength(1);
  });

  test('a reversal over what is left is a refusal', async () => {
    stubFetch(json(200, { items: [] }), json(400, refused));
    await expect(gateway().reverseTransferPartial('trf_1', 2500, 'k-1')).rejects.toBeInstanceOf(GatewayRefusedError);
  });

  test('a reversal whose earlier reversals cannot be read sends nothing', async () => {
    const sent = stubFetch(json(500, {}));
    await expect(gateway().reverseTransferPartial('trf_1', 2500, 'k-1')).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });
});

describe('createLinkedAccount', () => {
  const START: LinkProgress = { step: 'none', accountId: null, productId: null };
  const save = async () => {};
  const input: LinkedAccountInput = {
    referenceId: 'abcdef0123456789abcd',
    legalName: 'Sweet Crumbs LLP',
    contactName: 'Asha Rao',
    phone: '+919876543210',
    email: 'asha@example.com',
    emailGeneration: 0,
    pan: 'AAJFB4821K',
    holderName: 'Sweet Crumbs',
    accountNumber: '123456789012',
    ifsc: 'HDFC0001234',
    address: { street: '12 Church Street', city: 'bengaluru', postalCode: '560001' },
  };

  function stubAccounts() {
    return {
      accounts: { create: vi.fn<(params: Params) => Promise<{ id: string }>>(async () => ({ id: 'acc_1' })) },
      stakeholders: { create: vi.fn<(accountId: string, params: Params) => Promise<unknown>>(async () => ({ id: 'sth_1' })) },
      products: {
        requestProductConfiguration: vi.fn<(accountId: string, params: object) => Promise<{ id: string }>>(async () => ({ id: 'acc_prd_1' })),
        edit: vi.fn<(accountId: string, productId: string, params: object) => Promise<unknown>>(async () => ({ activation_status: 'activated' })),
      },
    };
  }

  test('makes the account, then its stakeholder, then configures Route with the bank details', async () => {
    const c = stubAccounts();
    expect(await gateway(c).createLinkedAccount(input, START, save)).toEqual({ id: 'acc_1' });

    const account = c.accounts.create.mock.calls[0]![0];
    expect(account).toMatchObject({
      phone: '9876543210',
      type: 'route',
      legal_business_name: 'Sweet Crumbs LLP',
      business_type: 'partnership',
      contact_name: 'Asha Rao',
      profile: {
        category: 'food',
        subcategory: 'restaurant',
        addresses: {
          registered: { street1: '12 Church Street', city: 'bengaluru', state: 'KARNATAKA', postal_code: '560001', country: 'IN' },
        },
      },
      legal_info: { pan: 'AAJFB4821K' },
    });
    expect(c.stakeholders.create.mock.calls[0]![0]).toBe('acc_1');
    expect(c.stakeholders.create.mock.calls[0]![1]).toMatchObject({ name: 'Asha Rao', email: account.email });
    expect(c.products.requestProductConfiguration).toHaveBeenCalledWith('acc_1', { product_name: 'route', tnc_accepted: true });
    expect(c.products.edit).toHaveBeenCalledWith('acc_1', 'acc_prd_1', {
      settlements: { account_number: '123456789012', ifsc_code: 'HDFC0001234', beneficiary_name: 'Sweet Crumbs' },
      tnc_accepted: true,
    });
  });

  test('the email is stable for one set of bank details, and changes with the generation', async () => {
    const c = stubAccounts();
    const g = gateway(c);
    await g.createLinkedAccount(input, START, save);
    await g.createLinkedAccount(input, START, save);
    await g.createLinkedAccount({ ...input, emailGeneration: 1 }, START, save);
    const [first, second, third] = c.accounts.create.mock.calls.map(([p]) => p.email as string);
    expect(first).toBe(`linked+${input.referenceId}.0@payouts.example.com`);
    expect(second).toBe(first);
    expect(third).toBe(`linked+${input.referenceId}.1@payouts.example.com`);
  });

  test('saves after each step, before going on to the next', async () => {
    const c = stubAccounts();
    const saved: LinkProgress[] = [];
    await gateway(c).createLinkedAccount(input, START, async (p) => {
      saved.push(p);
    });
    expect(saved).toEqual([
      { step: 'account', accountId: 'acc_1', productId: null },
      { step: 'stakeholder', accountId: 'acc_1', productId: null },
      { step: 'product', accountId: 'acc_1', productId: 'acc_prd_1' },
    ]);
  });

  test('a failed save stops the steps after it', async () => {
    const c = stubAccounts();
    await expect(
      gateway(c).createLinkedAccount(input, START, async () => {
        throw new Error('lost the claim');
      }),
    ).rejects.toThrow('lost the claim');
    expect(c.stakeholders.create).not.toHaveBeenCalled();
  });

  test.each(['account', 'stakeholder', 'product'] as const)('resuming after %s makes only the steps left', async (step) => {
    const c = stubAccounts();
    const id = await gateway(c).createLinkedAccount(input, { step, accountId: 'acc_kept', productId: 'acc_prd_kept' }, save);
    expect(id).toEqual({ id: 'acc_kept' });
    expect(c.accounts.create).not.toHaveBeenCalled();
    expect(c.stakeholders.create).toHaveBeenCalledTimes(step === 'account' ? 1 : 0);
    expect(c.products.requestProductConfiguration).toHaveBeenCalledTimes(step === 'product' ? 0 : 1);
    const productId = step === 'product' ? 'acc_prd_kept' : 'acc_prd_1';
    expect(c.products.edit).toHaveBeenCalledWith('acc_kept', productId, expect.anything());
  });

  test('an individual PAN is the proprietor, so it goes on the stakeholder', async () => {
    const c = stubAccounts();
    await gateway(c).createLinkedAccount({ ...input, pan: 'ABCPK1234L' }, START, save);
    const account = c.accounts.create.mock.calls[0]![0];
    expect(account.business_type).toBe('proprietorship');
    expect(account.legal_info).toBeUndefined();
    expect(c.stakeholders.create.mock.calls[0]![1]).toMatchObject({ kyc: { pan: 'ABCPK1234L' } });
  });

  test.each([
    ['AAACL1234C', 'private_limited'],
    ['AAATR1234C', 'trust'],
    ['AAAHR1234C', 'other'],
  ])('PAN %s reads as %s', async (pan, businessType) => {
    const c = stubAccounts();
    await gateway(c).createLinkedAccount({ ...input, pan }, START, save);
    expect(c.accounts.create.mock.calls[0]![0].business_type).toBe(businessType);
  });

  test('an address it cannot complete sends nothing', async () => {
    const c = stubAccounts();
    await expect(
      gateway(c).createLinkedAccount({ ...input, address: { street: null, city: null, postalCode: null } }, START, save),
    ).rejects.toThrow('address');
    expect(c.accounts.create).not.toHaveBeenCalled();
  });

  test('a city it has no state for sends nothing', async () => {
    const c = stubAccounts();
    await expect(gateway(c).createLinkedAccount({ ...input, address: { ...input.address, city: 'pune' } }, START, save)).rejects.toThrow('pune');
    expect(c.accounts.create).not.toHaveBeenCalled();
  });
});
