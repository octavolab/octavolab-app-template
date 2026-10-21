# Rollback plan for 20261021120300_order_checkout_payment_intent
Expand only: a new enum value and a nullable unique column. The previous app version ignores both, so rolling back the app is enough.
Caveat: orders already in `pending_payment` are unknown to the previous version's state machine; finish or cancel them before rolling back
(`UPDATE "Order" SET status = 'cancelled', version = version + 1 WHERE status = 'pending_payment';` only with Jaime's approval, and refund
any captured payment first). PostgreSQL cannot drop an enum value; leave it in place.
To drop the column: `DROP INDEX "Order_paymentIntentId_key"; ALTER TABLE "Order" DROP COLUMN "paymentIntentId";`
