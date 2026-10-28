# KRA eTIMS reconciliation contract status

**Conclusion: a safe OSCU/VSCU reconciliation contract is not established by
the official specification files currently in this repository.** Both specs
document sales-save operations and their immediate responses, but neither
documents a seller-side operation to retrieve the outcome of an earlier sales
submission by a pre-submission identifier. The adjacent purchase-sales search
is documented for buyers registering purchases. Its name and result fields do
not make it a sales-submission status query.

No reconciliation endpoint, retry, or readiness gate was changed for this
finding. The direct clients continue to report reconciliation as unverified;
their adapter capability flags remain false and the production eTIMS adapter
remains non-operational.

## Evidence reviewed

The local OSCU document identifies itself as **Online Sales Control Unit
(OSCU) Requirements & Communication Protocols, Version 2.0, April 2023**. Its
revision table says revision 2.0 updated test and production URLs on
20 April 2023. The local VSCU document identifies itself as **Virtual Sales
Control Unit Requirements & Communication Protocols, Version 2.0, April
2023**; its revision table records the KRA 20 April 2023 update to the JAR
package and environment addresses.

| Document and section                                                                                                                     | Operation and documented purpose                                                                                                                                                                                                                                                                                                                                                                | Evidence relevant to reconciliation                                                                                                                                                                                                                                                                                                                     | Conclusion                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OSCU_Specification_Document_v2.0.pdf`, §3.3.1.1, printed pp. 13–14; `VSCU_Specification_Document_v2.0.pdf`, §3.3.1.1, printed pp. 15–17 | OSCU initialization `/selectInitOsdcInfo` and VSCU initialization `/initializer/selectInitInfo` take taxpayer PIN, branch ID, and device serial. Their response includes device keys and last invoice/receipt counters (including last sale invoice and receipt numbers).                                                                                                                       | These values describe initialization/device state. No request-specific sales status, submitted invoice identity match, query time consistency, or link from a counter to the timed-out request is specified.                                                                                                                                            | A counter or communication key is not a reconciliation result and cannot prove that one particular sales request was accepted or rejected.                          |
| `OSCU_Specification_Document_v2.0.pdf`, §§3.2.1 and 3.3.6.1, printed pp. 9–10 and 37–42                                                  | `TrnsSalesSaveWrReq/Res`, path `/saveTrnsSalesOsdc`, saves taxpayer-client sales transaction and invoice information. Request includes `tin`, `bhfId`, `cmcKey`, `trdInvcNo`, `invcNo`, and `orgInvcNo`, plus sales fields. Response includes result fields and receipt data; the example returns result `000`, current/total receipt numbers, internal data, signature, and control-unit time. | A successful immediate response contains provider-generated receipt information. `trdInvcNo` and `invcNo` are submitted values, but the spec does not identify them as idempotency keys or define a lookup that accepts them.                                                                                                                           | The response can confirm success when received and validated. It cannot be recovered through a documented query after the response is lost.                         |
| `OSCU_Specification_Document_v2.0.pdf`, §§3.2.1 and 3.3.7.1, printed pp. 10 and 43 onward                                                | `TrnsPurchaseSalesSearchReq/Res`, `/selectTrnsPurchaseSalesList`, looks up sales information so a taxpayer can register purchases. The description says it returns unregistered information from sales assigned to the taxpayer as a transaction party.                                                                                                                                         | The request has taxpayer/branch and `lastReqDt`, not an operation/correlation identifier. Its documented purpose is purchase registration.                                                                                                                                                                                                              | Not a seller-side lookup for the result of `/saveTrnsSalesOsdc`; a returned list or empty result cannot prove whether this taxpayer's submission was accepted.      |
| `VSCU_Specification_Document_v2.0.pdf`, §§3.2.1 and 3.3.6.1, printed pp. 10–13 and 43–47                                                 | `TrnsSalesSaveReq/Res`, path `/trnsSales/saveSales`, saves sales transaction information from the taxpayer client. Request includes `tin`, `bhfId`, `trdInvcNo`, `invcNo`, and `orgInvcNo`, with sales, receipt, and item information. The JSON example's successful response returns result `000`, `rcptNo`, `totRcptNo`, internal data, signature, publication date, `sdcId`, and `mrcNo`.    | Receipt identifiers and signature data are generated in the response. The published response table and example differ on some field names; the client documentation already records that discrepancy. The spec does not define a client-supplied idempotency key or a status lookup using the submitted identifiers.                                    | An intact, validated success response can establish success. No documented method retrieves that same response after a timeout or restart.                          |
| `VSCU_Specification_Document_v2.0.pdf`, §§3.2.1 and 3.3.7.1, printed pp. 12 and 48–50                                                    | `TrnsPurchaseSalesReq/Res`, `/trnsPurchase/selectTrnsPurchaseSales`, selects purchase-sales information to register purchases for the taxpayer's branch. It describes unregistered sales associated with the taxpayer as transaction party.                                                                                                                                                     | Request is scoped by `tin`, `bhfId`, and `lastReqDt`; response contains supplier transaction information such as supplier PIN, branch, and invoice number. No prior-submission correlation identifier is specified.                                                                                                                                     | Not a reconciliation operation for the seller's own sales-save request. The spec does not state that this query is immediately consistent or complete for that use. |
| OSCU §4.18, printed p. 60; VSCU §4.14, printed pp. 83–84                                                                                 | Generic API response-code tables. Both list `000` as success and `001` as “There is no search result”; `894` describes a client/server communication error. `994` is described as “There is an overlapped Data.”                                                                                                                                                                                | The tables do not define a sales-write replay contract, duplicate key, lookup consistency window, or the relationship of these codes to an already committed sales transaction. In particular, `001` is not scoped as a negative result for a sales-submission lookup, and `994` does not specify whether the original result/receipt can be recovered. | These codes do not establish that a retry is safe or that a missing search result means no prior acceptance.                                                        |

The specifications also list the sales-save and purchase-sales-search operations
as separate functions; they do not list a sales-status, seller-invoice lookup,
receipt retrieval, or submission-reconciliation operation in the function
catalogues (§3.2.1). This is a finding about the supplied v2.0 documents, not a
claim that no newer or separately supplied KRA interface exists.

## Documented, inferred, and missing behavior

### Documented

- OSCU and VSCU expose sales-save operations and describe the fields in their
  immediate responses. A received `resultCd="000"` is described as success;
  the examples contain provider-generated receipt data.
- The sales-save request contains taxpayer and branch scope plus trader and
  invoice identifiers. The VSCU request also includes a sales type; the OSCU
  request includes its communication key.
- A separate purchase-sales search returns information used to register
  purchases and is described in terms of supplier sales visible to the
  transaction party.
- The generic result-code tables include “no search result,” communication
  error, and overlapped-data codes.

### Reasonable but unconfirmed interpretations

- `trdInvcNo` or `(tin, bhfId, invcNo)` might be useful to KRA support when
  investigating a submission. The specifications do not establish these as
  unique reconciliation keys or guarantee that a query can retrieve a record
  by them.
- “Overlapped Data” might be raised for duplicate data. No rule says which
  fields define overlap, whether it means the earlier operation committed, or
  how to obtain that earlier operation's receipt response.
- An immediate response with a non-success result code may represent an
  application rejection, but no complete code-by-code statement says that all
  non-`000` responses prove no sales record was committed. Code `894` is
  described as a communication error and especially needs clarification.

The current client maps any well-formed non-`000` result to a rejected result.
That local mapping is not proof that every such code is a definitive,
side-effect-free rejection. Until KRA supplies per-code write semantics, the
adapter remains disabled and code-specific retry decisions must not be based
on this mapping alone.

### Not established

- A lookup operation for a seller's own prior OSCU/VSCU sales submission.
- A provider request ID, idempotency key, duplicate response contract, or
  duplicate retention period.
- Whether a negative lookup result is final, immediately consistent, or
  delayed; whether it proves no transaction was accepted.
- Whether an accepted result can be recovered after a lost response, and which
  authoritative fields support matching it to the exact original invoice.
- Whether the purchase-sales list includes all accepted sales, its visibility
  delay, or its retention/history window.
- Safe automatic retry semantics after timeout, connection loss, HTTP/client
  communication errors, or a duplicate/overlap result.

## Timeout after possible transmission

Consider this sequence:

1. The middleware persists its eTIMS operation and the encrypted mapped
   payload before the provider call.
2. It sends the OSCU or VSCU sales-save request.
3. The connection times out after KRA may have received and processed it.
4. The middleware restarts without the immediate response.

The local durable record preserves the internal operation ID, fiscalization
request ID, Zoho invoice ID, internal correlation ID, payload hash, adapter and
mapping configuration identity, attempt history, and encrypted payload. The
mapped payload includes the configured `tin`, `bhfId`, `trdInvcNo`, `invcNo`,
and `orgInvcNo` values. The submission attempt is claimed and recorded before
the external call. `providerReference` is null until a validated provider
response supplies one.

These records are enough to preserve exactly what the middleware intended to
send and to prevent an automatic resubmission. They are not provider evidence
that KRA accepted or rejected it. The internal operation ID and correlation ID
are middleware identifiers; the KRA sales-save clients send the mapped KRA
payload and do not pass those IDs as a documented provider lookup key.

With the supplied contracts, the middleware cannot later determine whether the
original request was accepted, definitively rejected, or never committed. The
outcome must remain `outcome_unknown` / `reconciliation_required` until an
authoritative response or separately verified provider evidence is supplied.
A purchase-sales query returning no match is not enough to change that result.

## Current application behavior

- `KraOscuClient` and `KraVscuClient` implement the documented sales-save
  calls, but their readiness reports `reconciliationVerified: false` and
  `liveOperationPermitted: false`.
- `KraEtimsReportingAdapter` reports both reconciliation capability flags as
  false. Its `reconcile()` returns an unknown result requiring manual review;
  it makes no lookup request.
- The reporting service durably records the operation, payload, and submission
  attempt before the provider boundary. A timeout or malformed/ambiguous
  response stays uncertain. Terminal or uncertain operations are not blindly
  resubmitted.
- The background reconciliation worker is unavailable unless a selected
  adapter is ready and declares reconciliation support. The KRA adapters do
  not, so this worker does not make KRA reconciliation calls.

The behavior above is local application logic and synthetic-test evidence. It
is not KRA acceptance or runtime proof against an OSCU/VSCU service.

## Written confirmation required from KRA or the authorized integration provider

Before implementing a reconciliation call, obtain written, version-specific
answers to these questions:

1. What exact OSCU and VSCU operation retrieves the status and full result of
   one earlier sales-save request? Provide the supported path/method, request
   schema, response schema, and errors. If no such operation exists, state the
   approved manual resolution procedure.
2. Which identifier(s) are guaranteed unique and queryable before submission?
   Confirm whether `trdInvcNo`, `invcNo`, `(tin, bhfId, invcNo)`, or another
   client-generated value is an idempotency or lookup key, including scope,
   uniqueness rules, retention, and supported reuse.
3. Does repeating the same sales-save request return the original result,
   reject it as overlap, create another fiscal record, or have other behavior?
   How can the original receipt number, signature, and associated metadata be
   retrieved when the first response was lost?
4. For each relevant response code, especially `001`, `894`, `921`, `922`, and
   `994`, does the code prove that no sales record was accepted? Can processing
   have committed before that response is returned?
5. If a lookup returns no result, what consistency delay and finality guarantee
   apply? What polling interval/window and terminal condition are approved?
6. What taxpayer approval, enrollment, branch/device initialization, keys,
   environment, and API version are prerequisites for lookup and submission?
7. Which documented OSCU/VSCU specification and installed package versions
   govern the account, and how should the published sales response field
   discrepancies be handled?

## Minimum sandbox acceptance evidence

After written contract answers and an approved test account are available,
acceptance should include provider-approved cases for:

- a successful sales save with authoritative response and identifiers;
- a definitive rejected request and documented proof that no sale was saved;
- the provider accepting a sales save while the test client deliberately loses
  the response, followed by lookup that retrieves the exact original result;
- a request not received by the provider, followed by lookup and the documented
  terminal negative result;
- an immediate and delayed lookup after acceptance to establish visibility
  consistency;
- an identical repeated request to establish duplicate behavior without
  creating a second sale;
- each communication, overlap, and relevant server error code, with its
  side-effect and retry semantics;
- the taxpayer/branch scope and exact identifier matching required for each
  lookup.

Retain the approved request/response traces, test environment and installed
client versions, taxpayer/branch enrollment evidence, correlation between the
middleware operation and provider record, and KRA/provider acceptance result.
Synthetic fixtures and mocked HTTP tests cannot substitute for these results.

## Safe behavior until then

Keep automatic reconciliation and resubmission disabled for OSCU and VSCU.
Persist the original attempt and encrypted payload; preserve
`outcome_unknown`/`reconciliation_required`; expose the operation and
correlation information to an authorized operator; and require documented
provider or taxpayer evidence plus an audited manual-review decision before
changing the recorded outcome. Never interpret an empty purchase-sales result
as proof of non-acceptance, and never issue a second sales-save request merely
because the first response was lost.

No schema change is required for this evidence finding. The current operation
record and encrypted payload preserve middleware intent and allow later
investigation, but the payload hash, internal correlation ID, and persisted
invoice identifiers do not create provider idempotency or reconciliation
capabilities.
