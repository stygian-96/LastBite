-- Nothing reads a webhook's body once it is handled, and it holds customer details, so only the IDs
-- and the event type stay.
ALTER TABLE webhook_events ADD COLUMN subject_id text;

UPDATE webhook_events
   SET subject_id = coalesce(
     payload #>> '{payload,payment,entity,id}',
     payload #>> '{payload,refund,entity,id}',
     payload #>> '{payload,transfer,entity,id}'
   );

ALTER TABLE webhook_events DROP COLUMN payload;
