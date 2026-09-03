-- Tracks who acknowledged an assignment and by what method - a
-- dispatcher confirming "they got it over the radio" is a meaningfully
-- different kind of record than the field device itself confirming
-- receipt, and that distinction matters for accountability (the whole
-- point of the escalation ladder was knowing whether the message
-- actually reached someone).
ALTER TABLE assignments
  ADD COLUMN acked_by UUID REFERENCES staff(id),
  ADD COLUMN ack_method TEXT CHECK (ack_method IN ('self', 'dispatcher_override'));
