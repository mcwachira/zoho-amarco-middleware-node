# KRA OSCU and VSCU protocol clients

## Implementation status

The repository now has separate direct OSCU and local VSCU JSON clients in
`src/integrations/etims/`. The clients validate initialization data and KRA
response envelopes, enforce request/response size limits, support abort signals
and bounded timeouts, reject redirects, sanitize transport errors, and never
retry a call. A valid response with `resultCd="000"` is reported as the
protocol's success result; other valid result codes are explicit provider
rejections. HTTP success alone is not considered a KRA success.

The direct clients are protocol plumbing and remain contract-unverified. They
are now connected through `KraEtimsReportingAdapter` to the existing durable
eTIMS adapter boundary when explicit provider configuration is present. The
adapter reports `contractVerified=false`, `operational=false`, and no
reconciliation capability, so `EtimsReportingService` records a blocked
operation without calling the clients. If provider configuration is absent,
the server still injects `UnverifiedEtimsAdapter`. `ETIMS_REPORTING_ENABLED`
and `ETIMS_RECONCILIATION_ENABLED` remain false by default; setting them cannot
override the adapter's closed acceptance gate. Local mocked application tests
exercise the reporting service, payload vault, claim, adapter, and client
transport, but no production or sandbox call was made.

| Concern             | OSCU                                                                     | VSCU                                                                     |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Transport           | Direct HTTPS JSON to a KRA origin                                        | HTTP(S) JSON to the taxpayer-installed VSCU service                      |
| Environment         | Explicit `sandbox` or `production`; official origins are pinned in code  | Explicit `ETIMS_VSCU_BASE_URL`; no automatic package startup             |
| Implemented methods | Initialize, code list, item classification list, branch list, sales-save | Initialize, code list, item classification list, branch list, sales-save |
| Reconciliation      | No documented safe status lookup identified; unsupported                 | No documented safe status lookup identified; unsupported                 |
| Readiness           | Configuration only; no health request is made                            | Configuration only; no health request is made                            |
| Live use            | Blocked pending sandbox acceptance and certification                     | Blocked pending package, taxpayer, and contract acceptance               |

The endpoint path and request object are defined by each client's route table;
OSCU is never pointed at localhost and VSCU is never treated as the direct
OSCU API. The implementation currently sends JSON requests using HTTP POST,
which follows the specifications' request-body examples and REST service
description. The documents do not explicitly name the HTTP verb in the route
tables; verify it with the official sandbox before activating any provider.

## Payload and invoice mapping boundary

`KraEtimsReportingAdapter` receives the existing explicit eTIMS payload as a
KRA wire object and calls provider-specific `saveSales()` only after the
application readiness gate has passed. The direct clients validate provider-specific
top-level and nested receipt/item structures, documented field lengths, numeric
precision, date format and calendar validity, item count, and unique item
sequence numbers before transmission. OSCU requires its communication key;
VSCU requires `salesTyCd="N"` as stated by §3.3.6.1 and its receipt report
number. Successful sales data is typed and validated; malformed data after a
write is reported with an uncertain outcome. The decimal conversion helper
accepts no more than two fractional digits and rejects values outside exact
integer-cent range. No write is retried and no duplicate response is treated
as success.

This is request/response contract plumbing, not Zoho-to-KRA fiscal mapping.
The immutable snapshot and existing profiles do not contain all KRA item codes,
unit codes, tax type mappings, taxpayer transaction codes, payment mappings,
receipt fields, or invoice counters. Those values cannot be safely inferred
from Zoho tax labels or percentages. No authoritative taxpayer configuration
has populated them, so the application workflow continues to use the
unverified adapter and sales submission remains blocked. VSCU's response table
and JSON example disagree on the generated receipt field names; the OSCU
example's current-receipt key includes a trailing space and presents a string
where the table says NUMBER. The local schemas follow the published table for
OSCU and the published JSON example for VSCU. Both discrepancies require
authorized package/sandbox confirmation. The sales samples also serialize
`trdInvcNo` as a number despite declaring CHAR(50), and one VSCU sample's
`salesDt` contains a space despite declaring `yyyyMMdd`. The schemas follow
the declared field types/formats. The PDF examples are specification examples,
not evidence of provider acceptance.

## Configuration and Windows deployment

All values below are optional and do not enable reporting:

```dotenv
ETIMS_ADAPTER=vscu
ETIMS_VSCU_BASE_URL=http://127.0.0.1:8088
ETIMS_PROVIDER_TIMEOUT_MS=15000
# For direct OSCU, choose explicitly: sandbox or production.
ETIMS_OSCU_ENVIRONMENT=sandbox
ETIMS_REPORTING_ENABLED=false
ETIMS_RECONCILIATION_ENABLED=false
```

Set only the selected model's configuration. OSCU environment is mandatory to
construct its client and maps only to KRA's published test or production URL.
The VSCU base URL identifies a separately installed official JAR service. The
project does not bundle or install that JAR; the taxpayer must obtain the
approved distribution and supported Java runtime from KRA. The specification
revision 2.0 (20 April 2023) describes a Java JAR and Windows 10+ support. The
customer must confirm the exact package/runtime and port with KRA before
deployment. Configuration diagnostics do not start the service or verify its
version.

Do not put PINs, communication keys, or real request payloads in logs or
examples. Initialization and sales methods receive sensitive values only in
request bodies. The current client does not persist credentials or initialization
keys; a later accepted integration must use the existing secret-management
boundary and encrypted durable operation payload store.

## Sources and evidence level

- [OSCU Requirements & Communication Protocols v2.0, April 2023](https://www.kra.go.ke/images/publications/OSCU_Specification_Document_v2.0.pdf): §§1.2 (test/production URLs), 2.1–2.2 (approval, initialization, reference-data timestamps, direct non-Java connection), 3.3.1.1 (initialization), 3.3.2 (codes), 3.3.3.1 (classification), 3.3.4 (branches), 3.3.6.1 (sales transaction), and §4 result-code definitions. Its revision history says the URLs were updated on 20 April 2023.
- [VSCU Requirements & Communication Protocols v2.0, April 2023](https://www.kra.go.ke/images/publications/VSCU_Specification_Document_v2.0.pdf): §§1.2 and 2.2 (local JAR service and runtime), 3.2.1 (route table), 3.3.1.1 (formal `/initializer/selectInitInfo` route), 3.3.2 (codes), 3.3.3.1 (classification), 3.3.4 (branches), and 3.3.6.1 (sales transaction). The VSCU overview's sample uses `/selectInitInfo`, which conflicts with the formal route; the formal route is implemented and must be confirmed with the installed VSCU package. Revision 2.0 is dated 20 April 2023.
- [KRA system-to-system integration](https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/etims-system-to-system-integration): KRA requires development, testing, vetting, and certification before use.
- [KRA eTIMS service and current specification links](https://www.kra.go.ke/services/service/16).
- [KRA sandbox onboarding](https://etims.kra.go.ke/main/signup/indexLearnMore).
- [Tremol ZFP Lab libraries and release notes](https://tremol.bg/en/support/zfplab/MD/2403121055): notes include sequential shared-device command handling in ZFP Lab Server 1.6.1 and Node.js support in 1.5.9. The installed customer server/firmware version is unknown, so these notes do not establish the customer's device behavior.
- Supplied local protocol evidence: `docs/protocol_description_KE_CU_2509041522.pdf`, `docs/Manual.pdf`, and the command XML definitions in `docs/XML/`. The Kenya protocol's documented command signatures are not consistently represented by the generic ZFP argument definitions; payment request fields and status-bit XML serialization remain unresolved.

Salami documentation was not made a dependency or implementation target. The
user-provided Salami URLs were unavailable to the research browser, there is no
Salami account/token, and Salami examples would not establish KRA's direct OSCU
or VSCU contract.

## Remaining acceptance work

1. Obtain the current OSCU/VSCU package and customer-approved sandbox onboarding.
2. Confirm HTTP methods/headers, complete request/response models, duplicate
   behavior, and all status/error semantics in the authorized sandbox.
3. Add complete explicit taxpayer/item/payment profile fields and build/test
   full snapshot-to-request mapping with decimal reconciliation.
4. Determine whether the provider has a supported read-after-write lookup. Until
   then, a lost response after a write remains uncertain and cannot be retried.
5. Confirm the legally applicable ordering between any Tremol receipt and eTIMS
   reporting, then complete certification/vetting with KRA.
6. For Tremol, verify the installed G03 firmware, ZFP Lab Server version,
   command serialization/escaping, payment methods, receipt response, and
   post-timeout lookup on the physical customer's acceptance setup.

The KRA v2.0 PDFs state confidentiality restrictions. They are already supplied
in this repository; this document links to them and summarizes implementation
facts without reproducing their tables or examples.

## Runtime validation and reference synchronization boundary

The read operations now accept endpoint-specific request types. VSCU
incremental queries validate `tin`, `bhfId`, and the 14-digit `lastReqDt`;
OSCU queries additionally require `cmcKey` according to the OSCU field tables.
The OSCU JSON examples for code, classification, branch, and item searches omit
that table-required key. The client follows the field table and keeps this
specification discrepancy as an acceptance blocker.

Accepted reference responses are validated into concrete code-list,
classification-list, branch-list, or item-list shapes before they leave the
client. Only fields represented by those schemas are returned; unknown fields
are stripped. Invalid known fields fail closed. The schemas do not establish
provider acceptance, and the API still uses the non-operational
`UnverifiedEtimsAdapter`.

### Durable synchronization contract evidence

The official v2.0 documents are present locally as
`docs/OSCU_Specification_Document_v2.0.pdf` and
`docs/VSCU_Specification_Document_v2.0.pdf`. KRA's current system-to-system
page describes OSCU as always-online and VSCU as bulk-oriented/not always online,
and requires development, testing, vetting, and certification before use
([KRA system-to-system integration](https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/etims-system-to-system-integration)).

| Category             | Documented result form                                                                                                                     | Timestamp and scope                                                                                      | Deletion, replay, and cursor evidence                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Code lists           | OSCU §3.3.2 and VSCU §3.3.2.1 say the server returns codes “registered or modified after” `lastReqDt`: a delta, not a snapshot.            | 14-character `lastReqDt`; taxpayer and branch. OSCU table also requires `cmcKey`, omitted in its sample. | `useYn` exists; no tombstone/deletion rule, duplicate rule, or replay guarantee. `resultDt` is “Result Date,” not a defined cursor. |
| Item classifications | OSCU §3.3.3.1 and VSCU §3.3.2.2 specify lookup lists and `lastReqDt`; they do not explicitly say whether results are full or changed-only. | 14-character value; taxpayer and branch. OSCU table also requires `cmcKey`, omitted in its sample.       | `useYn` exists without transition/deletion semantics. No replay, snapshot, or cursor rule.                                          |
| Branches             | OSCU §3.3.4 and VSCU §3.3.2.4 specify a taxpayer branch lookup/list and `lastReqDt`; no completeness behavior is stated.                   | 14-character value; taxpayer and branch context; records carry `tin` and `bhfId`.                        | `bhfSttsCd` exists without a mapping. No tombstone, replay, snapshot, or cursor rule.                                               |
| Item data            | OSCU §3.3.3.2 and VSCU §3.3.4.2 specify a taxpayer item lookup/list and `lastReqDt`; no completeness behavior is stated.                   | 14-character value; taxpayer and branch context; records can carry `regBhfId`.                           | `useYn` exists without transition/deletion semantics. No tombstone, replay, snapshot, or cursor rule.                               |

Both documents define `resultDt` as a 14-character Result Date but do not state
its timezone, precision policy, or cursor meaning. None of the four calls
documents a continuation token. Neither missed-interval recovery/retention nor
malformed-response behavior is specified. Read responses are validated before
use and transport calls are not retried. Repeating a read may be operationally
harmless, but there is no formal replay guarantee or documented duplicate merge
rule. A malformed response fails validation and cannot replace active data.

The durable state record is keyed by provider, adapter identity, taxpayer,
branch, and category; it holds attempt diagnostics, nullable provider cursor
fields, and an expiring lease. Attempt-state updates require the matching lease
token while it is unexpired, so a stale worker cannot overwrite the latest
attempt status after losing ownership. Those cursor fields remain null. There
is no application sync worker, route, active reference-data store, or
successful-checkpoint operation. No response is activated as current reference
data: even the code-list delta cannot be applied safely without a verified
cursor/gap strategy and deletion behavior, and the other operations' result
completeness is unspecified. Synchronization stays disabled until KRA confirms
per-operation completeness, timezone, cursor advancement, gap recovery,
deletion/deactivation, and duplicate behavior. This is a provider-acceptance
requirement, not sandbox acceptance.

The integration health response reports these separately: configuration
validity means only that selected client configuration passed local
construction checks; `transportReady: not_checked` means no network probe ran;
contract tests are implemented but provider-unverified; sandbox verification,
provider approval, reconciliation verification, and live permission remain
false. No health call performs fiscal commands or makes KRA requests.
