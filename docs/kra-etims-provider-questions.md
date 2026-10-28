# Draft inquiry: KRA eTIMS integration contract and acceptance

**Draft for internal review. Not sent.** Complete taxpayer identifiers through an approved secure channel; do not place PINs, credentials, communication keys or real invoice data in ordinary email.

To: KRA eTIMS System-to-System Integration / Technical Support

Subject: Request for current taxpayer-specific OSCU/VSCU integration and acceptance requirements

Dear KRA eTIMS Integration Team,

We are preparing a Zoho Books integration for a taxpayer's outbound sales invoicing workflow and are reviewing KRA's published OSCU/VSCU materials. The public specifications we have reviewed identify TIS OSCU/VSCU v2.0 (April 2023), OSCU protocol v2.0 (April 2023) and VSCU protocol v2.0 (April 2023). We do not assume these remain the applicable revisions.

Could you please provide or confirm the following for the taxpayer and approved branches to be identified through your secure onboarding process?

## Current contract and taxpayer instructions

1. What are the currently applicable TIS, OSCU and VSCU specification versions and effective dates? Please provide the controlled documents, errata, release notes and any version-specific schemas/examples. Which earlier versions are superseded?
2. Which integration model is approved for this taxpayer: OSCU, VSCU or another supported system-to-system model? What criteria determine the permitted operating mode?
3. Please provide the taxpayer-specific onboarding, approval, integration registration, vetting and certification instructions, including required forms, milestones, evidence and support contacts.
4. For VSCU, what is the approved JAR/package build, checksum/signature, supported operating environment/runtime, local server configuration, route/version behavior and upgrade process? For OSCU, what are the current official test/production origins and network/TLS requirements?

## Sandbox access and authentication

5. How can the taxpayer obtain an approved sandbox/test account and credentials? Please state required PIN/branch/device enrollment, test data, access limits, environment separation and credential delivery/rotation process.
6. Please provide the current authentication and initialization contracts: HTTP methods, paths, headers, request/response schemas, field requiredness, taxpayer/branch/device identity rules, communication key lifecycle and reinitialization behavior.
7. Which current code-list, item classification, branch and item operations should a taxpayer use? Please clarify request cursors, response completeness, deletions/deactivation, timezone, missed intervals and item registration prerequisites.

## Sales submission and receipt evidence

8. Please provide the authoritative sales-save request and response schemas for the approved model, including HTTP method, required headers, limits, date/number formats and all required fields.
9. Published tables and examples appear to differ in some fields, including response receipt identifiers/types and sample date/number formats. Which forms are authoritative for the current version? Please provide canonical successful and validation-failure examples.
10. Which response fields constitute authoritative acceptance of one sale? Please define result codes, receipt number/counter, total counter, SCU ID, timestamp, internal data, digital signature, verification/QR data and any subsequent journal operation.
11. For each applicable success, validation, duplicate/overlap, communication and server result code, can the sale already have been committed? Which results definitively establish that no transaction was accepted?

## Timeouts, lookup results and duplicate submissions

12. Is there an officially supported operation to retrieve the final status and original receipt response for a previously submitted seller sale? If so, please provide its exact method/path, request/response schemas, required credentials and error behavior. If not, please confirm this and describe the approved manual resolution process.
13. Which identifier is guaranteed unique and queryable for that purpose? Please define its uniqueness scope, whether it must be allocated before submission, allowed reuse, retention period and relationship to taxpayer PIN/branch and transaction identifiers.
14. What happens if the identical sales-save request is submitted again after the first response is lost: does KRA return the original receipt, reject it, create another transaction, or behave differently? How can the original receipt evidence be recovered?
15. For any supported lookup, what do “no result” and other outcomes mean? Please specify visibility delay, consistency/completeness, retention, polling limits and the condition that makes a negative result final. Does an empty result ever authorize resubmission?
16. For timeout, disconnect, lost response, HTTP 5xx, communication result codes and malformed response after a request may have been sent, what should the taxpayer do? Please provide side-effect semantics and whether resubmission is permitted in each case.

## Financial mapping and sequence policy

17. Please confirm current tax type codes/rates and the required mapping of taxable, tax and total amounts. Are prices tax-inclusive or tax-exclusive, and what discount allocation, calculation order, decimal precision, rounding stage/mode and reconciliation tolerance apply?
18. Please provide current item classification, tax type, packaging unit and quantity unit catalogs, and rules for registering items, item-code uniqueness, inactive items and updates.
19. Is buyer PIN optional for every applicable sales case? Please confirm payment method codes, including treatment of multiple payment tenders.
20. Please define the distinct roles and allocation rules for the TIS invoice number/sequence, trader invoice number, original invoice number, report number and SCU-generated receipt counters, including reset, restore and recovery behavior. Which timestamp source, timezone and format applies to each date field?

## Sandbox acceptance, certification and production approval

21. What exact sandbox scenarios and evidence are required for successful submissions, definitive rejections, duplicates, delayed visibility, lost responses, non-received requests, sequence recovery and financial edge cases?
22. What formal KRA vetting/certification process applies, who approves production use, what is the approval scope and validity, and how are software/package changes re-certified?
23. Please identify the official incident/escalation channel for ambiguous outcomes and production service incidents, including evidence KRA requires to investigate a specific transaction.

We will keep production submissions disabled until the current contract, taxpayer authorization, sandbox acceptance, reconciliation/duplicate semantics (or approved manual procedure), financial mapping and certification requirements are documented and reviewed. We will not treat an empty lookup as proof of failure or retry an uncertain sale without authoritative guidance.

Thank you,

[Name]

[Organization / integration team]

[Contact details]

## Internal sending notes

- This is a draft only; it has not been sent and no KRA endpoint was contacted.
- Identify taxpayer and branch only through KRA's approved secure channel.
- Request versioned written answers and retain the response with the applicable specification/package build.
- Track each answer against [the integration acceptance checklist](kra-etims-integration-acceptance-checklist.md). A general answer should not be treated as taxpayer-specific authorization unless KRA confirms its scope.
