-- One plain-language line (<= 8 words) shown as the Work card/panel title when no clear owner action exists.
ALTER TABLE tickets ADD COLUMN headline text;
