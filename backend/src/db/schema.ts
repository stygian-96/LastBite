import { customType } from "drizzle-orm/pg-core"
import { pgTable, text, timestamp, index, uuid, smallint, unique, boolean, foreignKey, check, jsonb, date, integer, uniqueIndex, inet, time, bigserial, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// drizzle-kit pull cannot map bytea, so it is declared by hand.
const bytea = customType<{ data: Buffer }>({
	dataType() {
		return "bytea";
	},
});



export const schemaMigrations = pgTable("schema_migrations", {
	name: text().primaryKey().notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const otpCodes = pgTable("otp_codes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	phone: text().notNull(),
	codeHash: text("code_hash").notNull(),
	attempts: smallint().default(0).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("otp_codes_phone_created_at_idx").using("btree", table.phone.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
]);

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	phone: text().notNull(),
	name: text(),
	email: text(),
	isAdmin: boolean("is_admin").default(false).notNull(),
	whatsappOptIn: boolean("whatsapp_opt_in").default(true).notNull(),
	marketingOptIn: boolean("marketing_opt_in").default(false).notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("users_phone_key").on(table.phone),
]);

export const sessions = pgTable("sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	tokenHash: text("token_hash").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "sessions_user_id_fkey"
		}),
	unique("sessions_token_hash_key").on(table.tokenHash),
]);

export const brands = pgTable("brands", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	logoKey: text("logo_key"),
	createdBy: uuid("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "brands_created_by_fkey"
		}),
	unique("brands_slug_key").on(table.slug),
]);

export const payoutAccounts = pgTable("payout_accounts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	brandId: uuid("brand_id").notNull(),
	legalName: text("legal_name").notNull(),
	panEncrypted: bytea("pan_encrypted").notNull(),
	panLast4: text("pan_last4").notNull(),
	holderName: text("holder_name").notNull(),
	accountEncrypted: bytea("account_encrypted").notNull(),
	accountLast4: text("account_last4").notNull(),
	ifsc: text().notNull(),
	razorpayAccountId: text("razorpay_account_id"),
	status: text().default('pending').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "payout_accounts_brand_id_fkey"
		}),
	unique("payout_accounts_razorpay_account_id_key").on(table.razorpayAccountId),
	check("payout_accounts_status_check", sql`status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text, 'on_hold'::text])`),
]);

export const outlets = pgTable("outlets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	brandId: uuid("brand_id").notNull(),
	payoutAccountId: uuid("payout_account_id"),
	areaId: uuid("area_id"),
	branchName: text("branch_name").notNull(),
	slug: text().notNull(),
	category: text().notNull(),
	address: text(),
	pincode: text(),
	mapsUrl: text("maps_url"),
	contactPhone: text("contact_phone"),
	pickupInstructions: text("pickup_instructions"),
	openingHours: jsonb("opening_hours"),
	photoKeys: text("photo_keys").array().default([""]).notNull(),
	fssaiNumber: text("fssai_number"),
	fssaiExpiresOn: date("fssai_expires_on"),
	gstin: text(),
	commissionBps: integer("commission_bps").default(2000).notNull(),
	status: text().default('draft').notNull(),
	onboardingStep: smallint("onboarding_step").default(1).notNull(),
	pausedUntil: timestamp("paused_until", { withTimezone: true, mode: 'string' }),
	pauseReason: text("pause_reason"),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("outlets_area_id_idx").using("btree", table.areaId.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'live'::text)`),
	index("outlets_fssai_number_idx").using("btree", table.fssaiNumber.asc().nullsLast().op("text_ops")),
	index("outlets_status_submitted_at_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.submittedAt.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "outlets_brand_id_fkey"
		}),
	foreignKey({
			columns: [table.payoutAccountId],
			foreignColumns: [payoutAccounts.id],
			name: "outlets_payout_account_id_fkey"
		}),
	foreignKey({
			columns: [table.areaId],
			foreignColumns: [areas.id],
			name: "outlets_area_id_fkey"
		}),
	unique("outlets_brand_id_slug_key").on(table.brandId, table.slug),
	check("outlets_category_check", sql`category = ANY (ARRAY['bakery'::text, 'cafe'::text, 'restaurant'::text, 'sweets'::text, 'kitchen'::text])`),
	check("outlets_status_check", sql`status = ANY (ARRAY['draft'::text, 'in_review'::text, 'changes_needed'::text, 'live'::text, 'suspended'::text, 'closed'::text])`),
]);

export const areas = pgTable("areas", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	city: text().notNull(),
	name: text().notNull(),
}, (table) => [
	unique("areas_city_name_key").on(table.city, table.name),
	check("areas_city_check", sql`city = ANY (ARRAY['bengaluru'::text, 'hyderabad'::text])`),
]);

export const memberships = pgTable("memberships", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	brandId: uuid("brand_id").notNull(),
	outletId: uuid("outlet_id"),
	payoutAccountId: uuid("payout_account_id"),
	role: text().notNull(),
	removedAt: timestamp("removed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("memberships_user_id_brand_id_coalesce_idx").using("btree", sql`user_id`, sql`brand_id`, sql`COALESCE((outlet_id)::text, 'all'::text)`).where(sql`(removed_at IS NULL)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "memberships_user_id_fkey"
		}),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "memberships_brand_id_fkey"
		}),
	foreignKey({
			columns: [table.outletId],
			foreignColumns: [outlets.id],
			name: "memberships_outlet_id_fkey"
		}),
	foreignKey({
			columns: [table.payoutAccountId],
			foreignColumns: [payoutAccounts.id],
			name: "memberships_payout_account_id_fkey"
		}),
	check("memberships_role_check", sql`role = ANY (ARRAY['owner'::text, 'manager'::text, 'counter'::text])`),
]);

export const documents = pgTable("documents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	outletId: uuid("outlet_id"),
	payoutAccountId: uuid("payout_account_id"),
	kind: text().notNull(),
	fileKey: text("file_key").notNull(),
	status: text().default('pending').notNull(),
	rejectionReason: text("rejection_reason"),
	reviewedBy: uuid("reviewed_by"),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.outletId],
			foreignColumns: [outlets.id],
			name: "documents_outlet_id_fkey"
		}),
	foreignKey({
			columns: [table.payoutAccountId],
			foreignColumns: [payoutAccounts.id],
			name: "documents_payout_account_id_fkey"
		}),
	foreignKey({
			columns: [table.reviewedBy],
			foreignColumns: [users.id],
			name: "documents_reviewed_by_fkey"
		}),
	check("documents_kind_check", sql`kind = ANY (ARRAY['fssai'::text, 'pan'::text, 'gst'::text, 'bank_proof'::text])`),
	check("documents_status_check", sql`status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'replaced'::text])`),
	check("documents_check", sql`(outlet_id IS NOT NULL) <> (payout_account_id IS NOT NULL)`),
]);

export const agreements = pgTable("agreements", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	payoutAccountId: uuid("payout_account_id").notNull(),
	version: text().notNull(),
	signedName: text("signed_name").notNull(),
	signedBy: uuid("signed_by").notNull(),
	ipAddress: inet("ip_address").notNull(),
	signedAt: timestamp("signed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.payoutAccountId],
			foreignColumns: [payoutAccounts.id],
			name: "agreements_payout_account_id_fkey"
		}),
	foreignKey({
			columns: [table.signedBy],
			foreignColumns: [users.id],
			name: "agreements_signed_by_fkey"
		}),
	unique("agreements_payout_account_id_version_key").on(table.payoutAccountId, table.version),
]);

export const listings = pgTable("listings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	outletId: uuid("outlet_id").notNull(),
	type: text().notNull(),
	name: text().notNull(),
	description: text().notNull(),
	foodCategory: text("food_category").notNull(),
	diet: text().notNull(),
	allergens: text().array().default([""]).notNull(),
	valuePaise: integer("value_paise").notNull(),
	pricePaise: integer("price_paise").notNull(),
	defaultQuantity: integer("default_quantity").notNull(),
	pickupStart: time("pickup_start").notNull(),
	pickupEnd: time("pickup_end").notNull(),
	repeatDays: smallint("repeat_days").array().default([]).notNull(),
	photoKey: text("photo_key"),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.outletId],
			foreignColumns: [outlets.id],
			name: "listings_outlet_id_fkey"
		}),
	check("listings_type_check", sql`type = ANY (ARRAY['surprise_bag'::text, 'fixed_box'::text])`),
	check("listings_food_category_check", sql`food_category = ANY (ARRAY['bakery'::text, 'cafe'::text, 'meals'::text, 'desserts'::text])`),
	check("listings_diet_check", sql`diet = ANY (ARRAY['veg'::text, 'egg'::text, 'nonveg'::text, 'mixed'::text])`),
	check("listings_value_paise_check", sql`value_paise > 0`),
	check("listings_price_paise_check", sql`price_paise > 0`),
	check("listings_default_quantity_check", sql`default_quantity > 0`),
	check("listings_check", sql`price_paise <= value_paise`),
]);

export const drops = pgTable("drops", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	listingId: uuid("listing_id").notNull(),
	outletId: uuid("outlet_id").notNull(),
	serviceDate: date("service_date").notNull(),
	quantity: integer().notNull(),
	reservedCount: integer("reserved_count").default(0).notNull(),
	status: text().default('live').notNull(),
	name: text().notNull(),
	description: text().notNull(),
	type: text().notNull(),
	foodCategory: text("food_category").notNull(),
	diet: text().notNull(),
	allergens: text().array().notNull(),
	valuePaise: integer("value_paise").notNull(),
	pricePaise: integer("price_paise").notNull(),
	photoKey: text("photo_key"),
	pickupStartAt: timestamp("pickup_start_at", { withTimezone: true, mode: 'string' }).notNull(),
	pickupEndAt: timestamp("pickup_end_at", { withTimezone: true, mode: 'string' }).notNull(),
	salesEndAt: timestamp("sales_end_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("drops_outlet_id_service_date_idx").using("btree", table.outletId.asc().nullsLast().op("date_ops"), table.serviceDate.asc().nullsLast().op("date_ops")),
	index("drops_service_date_status_idx").using("btree", table.serviceDate.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.listingId],
			foreignColumns: [listings.id],
			name: "drops_listing_id_fkey"
		}),
	foreignKey({
			columns: [table.outletId],
			foreignColumns: [outlets.id],
			name: "drops_outlet_id_fkey"
		}),
	unique("drops_listing_id_service_date_key").on(table.listingId, table.serviceDate),
	check("drops_quantity_check", sql`quantity >= 0`),
	check("drops_status_check", sql`status = ANY (ARRAY['live'::text, 'paused'::text, 'cancelled'::text])`),
	check("drops_check", sql`(reserved_count >= 0) AND (reserved_count <= quantity)`),
	check("drops_check1", sql`pickup_end_at > pickup_start_at`),
]);

export const orders = pgTable("orders", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	number: bigserial({ mode: "bigint" }).notNull(),
	userId: uuid("user_id"),
	anonId: text("anon_id"),
	dropId: uuid("drop_id").notNull(),
	outletId: uuid("outlet_id").notNull(),
	serviceDate: date("service_date").notNull(),
	status: text().default('held').notNull(),
	pricePaise: integer("price_paise").notNull(),
	commissionBps: integer("commission_bps").notNull(),
	commissionPaise: integer("commission_paise").notNull(),
	taxPaise: integer("tax_paise").default(0).notNull(),
	pickupCode: text("pickup_code"),
	holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	allergenAckAt: timestamp("allergen_ack_at", { withTimezone: true, mode: 'string' }),
	paidAt: timestamp("paid_at", { withTimezone: true, mode: 'string' }),
	collectedAt: timestamp("collected_at", { withTimezone: true, mode: 'string' }),
	collectedBy: uuid("collected_by"),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	cancelledBy: uuid("cancelled_by"),
	cancelReason: text("cancel_reason"),
	rating: smallint(),
	payoutId: uuid("payout_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("one_order_per_outlet_night").using("btree", table.userId.asc().nullsLast().op("date_ops"), table.outletId.asc().nullsLast().op("uuid_ops"), table.serviceDate.asc().nullsLast().op("uuid_ops")).where(sql`((user_id IS NOT NULL) AND (status = ANY (ARRAY['held'::text, 'paid'::text, 'collected'::text, 'no_show'::text])))`),
	index("orders_drop_id_status_idx").using("btree", table.dropId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	index("orders_status_hold_expires_at_idx").using("btree", table.status.asc().nullsLast().op("timestamptz_ops"), table.holdExpiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'held'::text)`),
	index("orders_user_id_created_at_idx").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops")),
	uniqueIndex("pickup_code_per_outlet_night").using("btree", table.outletId.asc().nullsLast().op("uuid_ops"), table.serviceDate.asc().nullsLast().op("text_ops"), table.pickupCode.asc().nullsLast().op("text_ops")).where(sql`(pickup_code IS NOT NULL)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "orders_user_id_fkey"
		}),
	foreignKey({
			columns: [table.dropId],
			foreignColumns: [drops.id],
			name: "orders_drop_id_fkey"
		}),
	foreignKey({
			columns: [table.outletId],
			foreignColumns: [outlets.id],
			name: "orders_outlet_id_fkey"
		}),
	foreignKey({
			columns: [table.collectedBy],
			foreignColumns: [users.id],
			name: "orders_collected_by_fkey"
		}),
	foreignKey({
			columns: [table.cancelledBy],
			foreignColumns: [users.id],
			name: "orders_cancelled_by_fkey"
		}),
	foreignKey({
			columns: [table.payoutId],
			foreignColumns: [payouts.id],
			name: "orders_payout_id_fkey"
		}),
	unique("orders_number_key").on(table.number),
	check("orders_status_check", sql`status = ANY (ARRAY['held'::text, 'expired'::text, 'paid'::text, 'collected'::text, 'no_show'::text, 'cancelled'::text])`),
	check("orders_rating_check", sql`(rating >= 1) AND (rating <= 5)`),
]);

export const payments = pgTable("payments", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orderId: uuid("order_id").notNull(),
	razorpayOrderId: text("razorpay_order_id").notNull(),
	razorpayPaymentId: text("razorpay_payment_id"),
	status: text().default('created').notNull(),
	amountPaise: integer("amount_paise").notNull(),
	feePaise: integer("fee_paise"),
	method: text(),
	razorpayTransferId: text("razorpay_transfer_id"),
	transferPaise: integer("transfer_paise"),
	transferStatus: text("transfer_status").default('none').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("payments_order_id_idx").using("btree", table.orderId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "payments_order_id_fkey"
		}),
	unique("payments_razorpay_order_id_key").on(table.razorpayOrderId),
	unique("payments_razorpay_payment_id_key").on(table.razorpayPaymentId),
	unique("payments_razorpay_transfer_id_key").on(table.razorpayTransferId),
	check("payments_status_check", sql`status = ANY (ARRAY['created'::text, 'captured'::text, 'failed'::text])`),
	check("payments_transfer_status_check", sql`transfer_status = ANY (ARRAY['none'::text, 'on_hold'::text, 'released'::text, 'reversed'::text])`),
]);

export const payouts = pgTable("payouts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	payoutAccountId: uuid("payout_account_id").notNull(),
	periodStart: date("period_start").notNull(),
	periodEnd: date("period_end").notNull(),
	grossPaise: integer("gross_paise").notNull(),
	commissionPaise: integer("commission_paise").notNull(),
	feesPaise: integer("fees_paise").notNull(),
	adjustmentPaise: integer("adjustment_paise").default(0).notNull(),
	netPaise: integer("net_paise").notNull(),
	status: text().default('draft').notNull(),
	paidAt: timestamp("paid_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	taxPaise: integer("tax_paise").default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.payoutAccountId],
			foreignColumns: [payoutAccounts.id],
			name: "payouts_payout_account_id_fkey"
		}),
	unique("payouts_payout_account_id_period_start_key").on(table.payoutAccountId, table.periodStart),
	check("payouts_status_check", sql`status = ANY (ARRAY['draft'::text, 'held'::text, 'released'::text, 'paid'::text])`),
]);

export const issues = pgTable("issues", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orderId: uuid("order_id").notNull(),
	userId: uuid("user_id").notNull(),
	reason: text().notNull(),
	description: text(),
	photoKey: text("photo_key"),
	status: text().default('open').notNull(),
	resolution: text(),
	resolvedBy: uuid("resolved_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "issues_order_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "issues_user_id_fkey"
		}),
	foreignKey({
			columns: [table.resolvedBy],
			foreignColumns: [users.id],
			name: "issues_resolved_by_fkey"
		}),
	check("issues_reason_check", sql`reason = ANY (ARRAY['bag_not_ready'::text, 'quality'::text, 'allergen'::text, 'code_rejected'::text, 'other'::text])`),
	check("issues_status_check", sql`status = ANY (ARRAY['open'::text, 'resolved'::text])`),
]);

export const notifications = pgTable("notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	dedupeKey: text("dedupe_key").notNull(),
	phone: text().notNull(),
	template: text().notNull(),
	variables: jsonb().notNull(),
	channel: text().notNull(),
	status: text().default('pending').notNull(),
	attempts: smallint().default(0).notNull(),
	providerId: text("provider_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("notifications_status_created_at_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("text_ops")).where(sql`(status = 'pending'::text)`),
	unique("notifications_dedupe_key_key").on(table.dedupeKey),
	check("notifications_channel_check", sql`channel = ANY (ARRAY['whatsapp'::text, 'sms'::text])`),
	check("notifications_status_check", sql`status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])`),
]);

export const webhookEvents = pgTable("webhook_events", {
	eventId: text("event_id").primaryKey().notNull(),
	eventType: text("event_type").notNull(),
	payload: jsonb().notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const auditLog = pgTable("audit_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	actorId: uuid("actor_id"),
	action: text().notNull(),
	entity: text().notNull(),
	entityId: uuid("entity_id").notNull(),
	detail: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.actorId],
			foreignColumns: [users.id],
			name: "audit_log_actor_id_fkey"
		}),
]);

export const refunds = pgTable("refunds", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orderId: uuid("order_id").notNull(),
	paymentId: uuid("payment_id").notNull(),
	amountPaise: integer("amount_paise").notNull(),
	reason: text().notNull(),
	status: text().default('pending').notNull(),
	razorpayRefundId: text("razorpay_refund_id"),
	chargedTo: text("charged_to").notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	attempts: smallint().default(0).notNull(),
	adjustedPayoutId: uuid("adjusted_payout_id"),
}, (table) => [
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "refunds_order_id_fkey"
		}),
	foreignKey({
			columns: [table.paymentId],
			foreignColumns: [payments.id],
			name: "refunds_payment_id_fkey"
		}),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "refunds_created_by_fkey"
		}),
	foreignKey({
			columns: [table.adjustedPayoutId],
			foreignColumns: [payouts.id],
			name: "refunds_adjusted_payout_id_fkey"
		}),
	unique("refunds_payment_id_reason_key").on(table.paymentId, table.reason),
	unique("refunds_razorpay_refund_id_key").on(table.razorpayRefundId),
	check("refunds_amount_paise_check", sql`amount_paise > 0`),
	check("refunds_reason_check", sql`reason = ANY (ARRAY['vendor_cancelled'::text, 'late_payment'::text, 'duplicate_payment'::text, 'issue_resolution'::text])`),
	check("refunds_status_check", sql`status = ANY (ARRAY['pending'::text, 'processed'::text, 'failed'::text])`),
	check("refunds_charged_to_check", sql`charged_to = ANY (ARRAY['vendor'::text, 'platform'::text])`),
]);

export const follows = pgTable("follows", {
	userId: uuid("user_id").notNull(),
	outletId: uuid("outlet_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("follows_outlet_id_idx").using("btree", table.outletId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "follows_user_id_fkey"
		}),
	foreignKey({
			columns: [table.outletId],
			foreignColumns: [outlets.id],
			name: "follows_outlet_id_fkey"
		}),
	primaryKey({ columns: [table.userId, table.outletId], name: "follows_pkey"}),
]);

export const rateLimits = pgTable("rate_limits", {
	key: text().notNull(),
	windowStart: timestamp("window_start", { withTimezone: true, mode: 'string' }).notNull(),
	count: integer().default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.key, table.windowStart], name: "rate_limits_pkey"}),
]);
