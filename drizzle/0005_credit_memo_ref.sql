ALTER TABLE `vendor_disputes` ADD `credit_memo_ref` text;--> statement-breakpoint
-- Disputes credited before this change had their case number overwritten by the credit memo number: move the memo over and restore the case number from the letter's subject.
UPDATE `vendor_disputes` SET
  `credit_memo_ref` = `vendor_reference`,
  `vendor_reference` = CASE
    WHEN `letter_subject` LIKE '[%-CASE-%]%' THEN substr(`letter_subject`, 2, instr(`letter_subject`, ']') - 2)
    ELSE (SELECT upper(`short_name`) FROM `providers` p WHERE p.`id` = `vendor_disputes`.`provider_id`) || '-CASE-' || substr(`id`, 5)
  END
WHERE `vendor_reference` IS NOT NULL AND `vendor_reference` NOT LIKE '%-CASE-%';
