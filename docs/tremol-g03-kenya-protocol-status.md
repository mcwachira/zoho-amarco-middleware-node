# Tremol G03 Kenya protocol verification status

**Status: read-only protocol foundations implemented; receipt issuance remains disabled.**
The repository now contains the Kenya control-unit protocol and ZFP Lab Server
manual. The facts below are limited to what those documents explicitly state.
The installed server/firmware version, command-specific XML result mapping, and
vendor-confirmed hardware behavior remain unverified.

## Evidence inventory

| Evidence                                                                                                                    | Version/date in repository                                                    | What it establishes                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/protocol_description_KE_CU_2509041522.pdf`, §2.2.1, p. 10                                                             | PDF metadata creation/modification 11 Sep 2025; filename encodes `2509041522` | `ReadStatus` output is six status bytes; defines ST0-ST5 flag bits and meanings.                                                                                                    |
| `docs/protocol_description_KE_CU_2509041522.pdf`, §§2.2.2, 2.5.2, 2.5.5, 2.5.7, pp. 10, 23, 26-29                           | Same local PDF                                                                | Documents `ReadVersion`, invoice open, `SellPLUfromExtDB`, and `CloseReceipt` names/fields; does not provide their HTTP request serialization or captured response bodies.          |
| `docs/Manual.pdf`, §§4.1, 4.12, pp. 8, 29                                                                                   | PDF metadata creation/modification 4 Aug 2021; no revision label established  | ZFP Lab Server uses synchronous HTTP GET command requests; gives XML `Res` success/error envelope examples and a generic `<Res Name Value Type>` data-result example.               |
| `src/infrastructure/device/tremol-zfplabserver-client.ts`                                                                   | Application implementation                                                    | Implements the four-command read-only GET allowlist, validates `ReadVersion`, maps only source-defined status fields, and parses close metadata without executing receipt commands. |
| `src/infrastructure/device/tremol-device-diagnostics.ts`                                                                    | Application implementation                                                    | Uses `ReadVersion()` for endpoint connectivity only; this result is not a readiness decision.                                                                                       |
| `src/infrastructure/device/tremol-receipt-command-builder.ts` and `src/infrastructure/device/zoho-tremol-receipt-mapper.ts` | Application implementation                                                    | Build a non-executable proposal only; they do not call the device.                                                                                                                  |
| `prisma/postgresql/schema.prisma`, repository mappers                                                                       | Current schema and source                                                     | Receipt persistence currently stores CU receipt number and issue time, but no QR data.                                                                                              |

### XML catalogue inspection

The XML files under `docs/XML/` are command definitions/configuration
descriptions, not captured device or ZFP Lab Server response fixtures:

| File(s)                                                                        | Classification and contract evidence                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_ServerStartupSettings.xml`                                                   | ZFP Lab Server startup-settings example: includes encoding and startup options, but no documented operator credentials or authentication behavior.                                                                                           |
| `ReadStatus.xml`, `s_ReadStatus.xml`                                           | Command definitions. They name documented status flags and byte/bit locations; the `s_` variant adds `CmdByte`, operation text and raw `<StatusBytes[6]>` representation. Neither contains a populated response.                             |
| `ReadVersion.xml`, `s_ReadVersion.xml`                                         | Command definitions. Both describe a `Version` result; the detailed form specifies up to 30 symbols and raw `<Version[30]>`, not a captured response envelope.                                                                               |
| `OpenInvoiceWithFreeCustomerData.xml`, `s_OpenInvoiceWithFreeCustomerData.xml` | Command signature/definition. The detailed form gives seven customer/trader arguments and hardcoded fields, but no operator-number or password argument. Its prose mentions assigned operator credentials, leaving the mechanism unresolved. |
| `SellPLUfromExtDB.xml`, `s_SellPLUfromExtDB.xml`                               | Command signature/definition with named sale fields and optional quantity/discount markers. VAT class A is the only listed option; this is not evidence that A is the correct tax class for any invoice.                                     |
| `CloseReceipt.xml`, `s_CloseReceipt.xml`                                       | Command response definition for `InvoiceNum` (19 symbols) and `QRcode` (128 symbols); the detailed raw layout places the two fields in that order. No populated close response is supplied.                                                  |

Consequently, these XML files establish names, declared field limits, and
protocol definition details only. They do not prove the installed server's
runtime response serialization or a successful physical close operation. The
generic `Res` envelope in the ZFP manual plus the close XML field definitions
support a strict parse-only `InvoiceNum`/`QRcode` parser; its synthetic test
fixture is not a captured device response. No XML file provides a verified
payment command contract.

The manuals are the primary protocol evidence for names and control-unit
fields. The ZFP Lab Server manual separately establishes HTTP GET and generic
XML response behavior; it does not establish that the generic invoice examples
are valid for the installed Kenya server/firmware.

### Verified operation evidence map

| Operation                              | Kenya control-unit protocol evidence                                                                                                                                                                                                                                                                                                                                   | ZFP Lab Server evidence                                                                                                                                                                                                      | Implementation state                                                                                                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReadStatus()`                         | §2.2.1, p. 10: six raw status bytes; individual flag meanings and byte/bit locations are listed.                                                                                                                                                                                                                                                                       | §4.12, p. 29: generic named results use `Res`/`Name`/`Value`/`Type`. The supplied `docs/XML/ReadStatus.xml` names the 21 status fields and their byte/bit locations; it is a definition, not a captured HTTP response.       | Parser maps named `Type="Status"` values `0`/`1`; missing fields remain unknown and readiness remains unknown. Actual target-server XML field emission is unverified.                                                                                     |
| `ReadVersion()`                        | §2.2.2, p. 10: no input; output `Version[30]`.                                                                                                                                                                                                                                                                                                                         | §4.1 and §4.12, pp. 8, 29: commands execute synchronously; generic XML response envelope.                                                                                                                                    | Read-only connectivity check parses exactly one named `Version` value of at most 30 characters. It is not matched to a compatibility matrix.                                                                                                              |
| `OpenInvoiceWithFreeCustomerData(...)` | §2.5.2, p. 23: ordered `CompanyName[30]`, `ClientPINnum[14]`, `HeadQuarters[30]`, `Address[30]`, `PostalCodeAndCity[30]`, `ExemptionNum[30]`, `TraderSystemInvNum[15]`; no data output. Operation prose mentions assigned operator credentials, but signature omits them.                                                                                              | §4.12, p. 29 shows generic `OpenReceipt(OperNum, OperPass)` only, not the Kenya invoice operation.                                                                                                                           | Not executable. The operator credential mechanism for this Kenya operation remains unresolved.                                                                                                                                                            |
| `SellPLUfromExtDB(...)`                | §2.5.5, printed p. 27: ordered `NamePLU[36]`, `OptionVATClass[1]` (listed value A), `Price[1..15]` (up to 5 fractional digits), `MeasureUnit[3]`, `HSCode[10]`, `HSName[20]`, `VATGrRate[1..5]`; optional `*Quantity[1..10]`, then optional `,DiscAddP[1..7]`; output ACK. The prose field sequence and `zfpdef` signature are inconsistent about HS name/rate fields. | §4.12, p. 29 generic request examples are not Kenya-specific.                                                                                                                                                                | Non-executable planner only. Exact SDK signature/HTTP parameter representation and field discrepancy need confirmation against installed definitions.                                                                                                     |
| `Subtotal(...)`                        | §2.5.6, p. 29: input includes hardcoded `OptionPrinting='0'`, `OptionDisplay[1]`, optional `:DiscAddV[1..13]`, and optional `,DiscAddP[1..7]`; output `SubtotalValue[1..13]`.                                                                                                                                                                                          | `s_Subtotal.xml` includes the hardcoded printing option; `Subtotal.xml` omits it. The PDF `zfpdef` signature also omits that hardcoded field.                                                                                | Not executable. The current proposal's `Subtotal()` has no arguments and does not implement this input contract; the two XML definitions conflict.                                                                                                        |
| `CloseReceipt()`                       | §2.5.7, p. 29: no input; output `InvoiceNum[19];QRcode[128]`; XML files declare `InvoiceNum` and `QRcode` as text with matching maximum lengths.                                                                                                                                                                                                                       | §4.12, p. 29 documents generic named XML result values, but provides no captured close response or close-specific success example.                                                                                           | Parse-only metadata parser validates exactly one non-empty invoice number (max 19) and one QR string (max 128) in a `Code=0` generic response. It is not connected to a sender, does not verify physical issuance, and does not persist metadata.         |
| Payment                                | §1.3, p. 9 identifies payment numbers 0 (cash) and 11 (VAT account). §3, p. 60 gives only a high-level description of command 35h: amount due, payment type, partial/full payment, and change calculation. The Kenya receipt-command section (§2.5) does not give a 35h payment field contract.                                                                        | The XML catalogue contains no payment command definition. The generic manual's `Payment()` and `CashPayCloseReceipt()` examples are not evidence of the Kenya G03 command sequence. No payment response fixture is supplied. | Not executable. The typed payment-evidence model checks input consistency using exact decimal arithmetic, but every reported assessment remains blocked because the source, payment rules, supported methods, and device command contract are unverified. |

### Payment evidence boundary

The invoice mapper deliberately excludes Zoho invoice `amount_paid`, payment
mode, and invoice status as payment evidence. The domain model in
`src/domain/fiscalization/payment-evidence.ts` can represent unavailable or
reported evidence, transaction details, and unpaid/partial/full/refunded/
unresolved states. Its assessment checks currency and amount reconciliation
without floating-point conversion. It is not connected to an upstream payment
source, persisted in the immutable invoice snapshot, or accepted as permission
to issue a receipt. It always reports `payment_source_unverified` and
`payment_rules_unverified`; a method is not deemed supported from its label.

The Zoho Books API operation and response contract for retrieving settled
payment transactions, allocation to an invoice, refunds, and timestamps must
be verified before evidence can be supplied. The supplied protocol documents
also do not define the Kenya G03 payment command arguments, accepted payment
types, or tender/change semantics. No payment value is inferred from invoice
totals, status, or invoice existence.

The generic ZFP manual example `OpenReceipt(OperNum=1,OperPass=0)` shows that
operator number/password can be command arguments for that generic operation.
It does not establish how credentials are supplied for Kenya's
`OpenInvoiceWithFreeCustomerData`, whose protocol signature omits them while
its prose references an assigned operator/password. Obtain the installed SDK
definition or written Tremol confirmation before implementing this operation.
The same manual documents command requests as HTTP GET paths such as
`/OpenReceipt(OperNum=1,OperPass=0)` and requires waiting for each response
before sending another command (§4.12). This generic example does not validate
any Kenya-specific invoice command argument representation.

## Current implementation audit

### Read-only client and diagnostics

`TremolZfpLabServerClient` accepts these strings in its read-command type:
`ReadStatus()`, `ReadVersion()`, `ReadCurrentReceiptInfo()`, and
`ReadLastAndTotalReceiptNum()`. The implementation appends the selected string
to the configured base URL, sends HTTP `GET`, and applies a default 5-second
timeout. It parses XML that has exactly one `Res` root and a numeric `Code`
attribute; a zero code is treated as success and a nonzero code as a device
error. `readStatus()` validates the generic envelope and maps only the named
`Type="Status"` fields defined by the supplied Kenya SDK definitions. Missing
fields remain unknown and readiness is always unknown. The SDK schema is
source evidence, not a captured response from the installed LabServer.

The application invokes `ReadVersion()` from
`TremolDeviceDiagnostics.checkConnection()`. The server constructs one client
at startup and exposes that check through `/health/device`. The client checks
the documented `Version` result name and its 30-character limit. A successful
response means only that the configured endpoint returned a parseable version;
it does not verify the device model, firmware compatibility, readiness, or
ability to issue a compliant receipt. A captured/sanitized `ReadStatus()`
response from the target ZFP Lab Server is needed to confirm that installation
emits the supplied named status fields and `Type="Status"` values. Readiness
is never reported as true.

The HTTP transport and XML command parser are separate modules. The transport
owns bounded GET requests, abortable shutdown, and the `fetch` boundary; the
client owns command allow-listing, XML validation, sequential execution, and
version/status parsing. The client serializes requests only within one client
instance. It has no cross-process lock or device-wide coordination. A timeout
or connection loss is classified as an unknown transport outcome; it is never
retried. Although the allow-list is named “read commands,” read-only behavior
and repeat safety remain unverified for this Kenya CU until the vendor confirms
them. Error objects retain only bounded status/result codes and do not retain
the complete response body.

HTTP errors and nonzero result codes retain only the HTTP status or numeric
result code in their error objects; provider response bodies and messages are
not retained. Successful command responses include the parsed result and raw
body in the internal client return value, so callers must not log or expose it
without a reviewed redaction policy. The health diagnostic response reduces
failures to an error name and does not return response content or the configured
endpoint.

| Existing operation                                     | Source-level effect                                       | Request/response behavior in code                                                       | Protocol status / repeat safety                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ReadVersion()` via `/health/device`                   | Reads version information per protocol §2.2.2             | HTTP GET; XML `Res Code="0"` accepted; errors retain only status/result code            | Read operation documented; repeat behavior not specified                                         |
| `ReadStatus()`                                         | Reads six status bytes per protocol §2.2.1                | Same GET; maps only named `Type="Status"` values `0`/`1`; missing values remain unknown | Read operation documented; target-server XML serialization and repeat behavior need confirmation |
| `ReadCurrentReceiptInfo()`                             | Reads current receipt information per protocol §2.6.6     | Same GET and generic XML envelope                                                       | Read operation documented; repeat behavior not specified                                         |
| `ReadLastAndTotalReceiptNum()`                         | Reads receipt-number information per protocol §2.6.5      | Same GET and generic XML envelope                                                       | Read operation documented; repeat behavior not specified                                         |
| `OpenInvoiceWithFreeCustomerData(...)` in receipt plan | Locally generated text only; plan has `executable: false` | No transport call or device response                                                    | Unverified; must not be sent                                                                     |
| `SellPLUfromExtDB(...)` in receipt plan                | Locally generated text only; plan has `executable: false` | No transport call or device response                                                    | Unverified; must not be sent                                                                     |
| `Subtotal()` in receipt plan                           | Locally generated text only; plan has `executable: false` | No transport call or device response                                                    | Unverified; must not be sent                                                                     |

For the four GET commands, a timeout or disconnect is an ambiguous response
from the service. The manuals describe these operations as reads, but do not
specify transport retry behavior or repeat guarantees.
For the three planned strings, there is no device operation in this code path.

`parseTremolCloseReceiptMetadata()` validates the documented close fields in
the generic XML `Res` envelope, but it is a pure parser and is not exposed as
a command or used to claim fiscal success. Required runtime verification is a
sanitized close-response sample from the installed ZFP Lab Server and vendor
confirmation of close result-code semantics and QR value encoding.

### Receipt-plan assumptions that remain unverified

The current planner accepts only KES, requires VAT class `A`, limits some
customer and item fields, validates decimal strings and precision, rejects
selected command delimiters, and emits the command strings and argument order
shown in its unit tests. These are implementation constraints and mock
expectations, not verified Kenya G03 rules. In particular:

- The planner's VAT class acceptance does not establish a correct VAT mapping,
  rate, exemption, HS code, or KRA/eTIMS treatment.
- Character limits, delimiter restrictions, field names, argument ordering,
  decimal precision, negative-price handling, and encoding have no cited
  official source in this repository.
- The plan has no payment, receipt-close, cancellation, receipt-number
  extraction, or fiscal-metadata reconciliation sequence.
- A green unit test proves only local code behavior against synthetic inputs.

## Capability matrix

“Unverified” means no authoritative Kenya-specific document or
vendor-confirmed test evidence is available in this repository. Source code
and mock tests are listed as implementation evidence only; they do not upgrade
the verification status.

| Capability                                       | Status                | Local implementation evidence                                                                                                                                                                                                        | Evidence required                                                                                                                                                                                |
| ------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Device identification and firmware compatibility | Unverified            | `ReadVersion()` is parsed, but no compatibility matrix is applied                                                                                                                                                                    | Official G03 Kenya model identification and firmware compatibility document; vendor confirmation of returned version semantics                                                                   |
| Connection and transport behavior                | Unverified            | Configurable HTTP(S) base URL, GET, timeout, and mock transport                                                                                                                                                                      | Versioned ZFP Lab Server interface document covering transport, URL, authentication, TLS, ports, timeouts, and connection lifecycle                                                              |
| Read-only status and diagnostics                 | Partially implemented | The client validates the generic XML envelope; `ReadVersion()` parses its named value and `ReadStatus()` maps source-defined `Type="Status"` names when present. `ReadVersion()` is connectivity only and readiness remains unknown. | Sanitized installed-server status XML fixture and vendor-confirmed interpretation/readiness criteria; firmware compatibility                                                                     |
| Receipt opening                                  | Blocked               | `OpenInvoiceWithFreeCustomerData(...)` appears only in non-executable plan.                                                                                                                                                          | Resolve the mismatch between omitted operator parameters in the protocol signature and operator credentials in its prose; establish installed server command signature and credential mechanism. |
| Customer information                             | Unverified            | Planner renders customer fields into a string                                                                                                                                                                                        | Official field names, limits, optionality, encoding, PIN/exemption requirements, and validation rules                                                                                            |
| Item registration and line entry                 | Unverified            | `SellPLUfromExtDB(...)` appears only in non-executable plan                                                                                                                                                                          | Official Kenya contract for item lookup/registration, line entry, field semantics, unit/HS data, and error responses                                                                             |
| Tax/VAT classification                           | Unverified            | Planner allows class `A`; no verified mapping exists                                                                                                                                                                                 | Official device and KRA/eTIMS mapping guidance for the target device, firmware, registration, and applicable Kenyan tax rules                                                                    |
| Discounts and totals                             | Unverified            | Optional discount percentage can be rendered; no total is calculated or cross-checked                                                                                                                                                | Official discount/addition rules, rounding and total calculation behavior, and corresponding response evidence                                                                                   |
| Payment handling                                 | Blocked               | Not implemented.                                                                                                                                                                                                                     | Exact Kenya operation name, argument order, payment-type mapping, tender/change semantics, and error semantics.                                                                                  |
| Receipt closure                                  | Blocked               | Not implemented. Kenya protocol names `CloseReceipt()` but server response mapping is unavailable.                                                                                                                                   | Installed-server close response fixture/contract and completion semantics.                                                                                                                       |
| Receipt identifiers and returned fiscal metadata | Partially verified    | Kenya protocol documents a close output with invoice number and QR code; neither is parsed/persisted from a device response.                                                                                                         | Exact ZFP XML field names, encoding, and close confirmation semantics.                                                                                                                           |
| Cancellation or void behavior                    | Unverified            | Not implemented                                                                                                                                                                                                                      | Official Kenya-specific cancellation/void authority, allowed state/time windows, commands, and audit results                                                                                     |
| Busy responses and command serialization         | Unverified            | In-process queue serializes calls in one client instance                                                                                                                                                                             | Official busy/result-code definitions and device-wide concurrency rules, including multiple process/client behavior                                                                              |
| ACK/NACK and documented response types           | Unverified            | Parser expects only `Res` with numeric `Code`; does not parse a command-specific schema                                                                                                                                              | Versioned response catalogue for success, warnings, errors, ACK/NACK, partial results, and firmware variations                                                                                   |
| Timeout/disconnected-response behavior           | Unverified            | Abort signal rejects the HTTP call; no device-state determination                                                                                                                                                                    | Vendor description of server/device behavior when a connection drops before, during, or after command execution                                                                                  |
| Determine issuance after a lost response         | Unverified            | No reconciliation operation or authoritative check is implemented                                                                                                                                                                    | Vendor-approved inquiry/reconciliation procedure that can identify the exact receipt without reissuing                                                                                           |
| Recovery and reconciliation                      | Unverified            | Application fiscalization service can preserve `OutcomeUnknown`; device-specific reconciliation is absent                                                                                                                            | Documented safe recovery runbook and authoritative evidence sources, including operator actions and audit requirements                                                                           |
| Character encoding and monetary formats          | Unverified            | JavaScript strings and decimal validation are used in a plan                                                                                                                                                                         | Official character set/escaping, maximum lengths, currency representation, decimal scale, rounding, negative values, and overflow behavior                                                       |

The protocol field names/bit meanings and generic ZFP HTTP/XML envelope are
documented; installed-server compatibility and command-specific serialization
are not vendor-confirmed. No capability is hardware-verified.

## Safe integration boundary

## Runtime adapter configuration and hardware-free tests

`TREMOL_ADAPTER` defaults to `disabled`. Setting it to
`zfplabserver_readonly` explicitly registers the ZFP Lab Server client,
diagnostics service, and blocked `FiscalDevice` with the application. Only
`TREMOL_TRANSPORT=http` is supported. `TREMOL_BASE_URL` must be an HTTP(S)
origin and remote production URLs must use HTTPS. `TREMOL_TIMEOUT_MS` defaults
to 5 seconds and is bounded to 100–120 seconds. No constructor sends a request.
When selected, `/health/device` performs `ReadVersion()` as a connectivity
check; a successful response does not establish readiness or receipt capability.

Run all adapter tests without hardware using:

```bash
LOG_LEVEL=silent pnpm exec vitest run \
  tests/unit/tremol-zfplabserver-client.test.ts \
  tests/unit/tremol-zfplabserver-transport.test.ts \
  tests/unit/tremol-fiscal-device.test.ts \
  tests/unit/tremol-device-diagnostics.test.ts \
  tests/unit/tremol-simulator.test.ts --reporter=dot
```

The client has a four-command read-only allow-list, with application-level
methods for `ReadVersion()` and `ReadStatus()`. Status fields are mapped only
when the response uses the supplied definition's named `Type="Status"`
representation; absent or different fields remain unknown. All requests are
serialized per client instance.
Network errors/timeouts return a typed unknown transport outcome and are not
retried. HTTP/result-code errors retain only status/result code in the error,
not the full response body. Shutdown aborts active transport requests and
rejects future requests. Cancellation by the client cannot establish whether
the remote server already processed a request.

The processing path is wired through request registration, atomic claim,
stored-snapshot validation, device boundary, and durable outcome persistence.
The production server uses a disabled issuance policy. By default no device
adapter is selected; when the explicitly read-only adapter is selected, its
`FiscalDevice` implementation remains blocked. The issuance guard runs before
database lookup or claim and requires verified payment-source, tax-rule, and
device-contract prerequisites. The route therefore reports a blocked result
without changing a request or contacting the fiscal unit.

The `FiscalDevice.issueReceipt(snapshot)` boundary receives only the immutable
stored snapshot. The application service distinguishes confirmed success,
confirmed failure, and unknown outcomes and does not automatically retry an
uncertain device operation. This is a safe application boundary, not evidence
that a production device adapter can yet meet it. Payment transactions are not
present in the snapshot; invoice `paid` status is not treated as a transaction.
Zoho write-back and eTIMS submission are not configured and remain separately
reported as `not_configured`.

The local `TremolFiscalDevice` validates its base URL, bounded timeout values,
and single-operation setting. Runtime selection defaults to
`TREMOL_ADAPTER=disabled`; explicitly selecting `zfplabserver_readonly` opts
into HTTP diagnostics and a blocked `FiscalDevice` registration. The selected
transport is `TREMOL_TRANSPORT=http`; all other values fail configuration
validation. In production the endpoint must use HTTPS. Neither option changes
the disabled issuance policy. The receipt path validates and builds a
non-executable plan, then returns `RECEIPT_ISSUANCE_BLOCKED`; it does not send a
receipt command even if its local opt-in flag is set. A plan validation error is
returned as a pre-send `INVALID_RECEIPT_PLAN` failure, not an uncertain device
outcome. The application-level test uses a synthetic HTTP transport and proves
that readiness is rejected before a durable claim or any HTTP request. This is
mock-only evidence and does not verify real server or hardware behavior.

The generic manual's §4.1 requires callers not to send a subsequent command
before receiving the preceding response; its §4.12 documents direct HTTP GET
requests. The client serializes only within one process/client instance. Neither
manual establishes cross-process locking, post-timeout cancellation semantics,
receipt idempotency, or a recovery lookup usable after restart. The locally
included documentation does not establish an SDK binary suitable for this
runtime. No real receipt command is implemented or permitted until those gaps
are resolved. The transport can be tested on developer machines with a fake
`fetch`; adapter tests never open a physical-device connection.

Before any issuer is implemented or enabled:

- Keep read-only diagnostics independent from receipt operations and expose
  only diagnostics whose read-only semantics have been vendor-confirmed.
- Serialize operations per physical device across every process that could
  address it; the current client-local promise queue is insufficient for
  multi-process safety.
- Map a response to success or confirmed failure only from documented
  authoritative evidence. Treat timeout, disconnect, malformed/partial
  responses, and persistence failure after a possible device operation as
  uncertain.
- Do not retry issuance after uncertainty. Require a vendor-documented
  reconciliation path and operator policy before another fiscal command.
- Preserve the original snapshot, exact request/response evidence needed for
  audit, and any verified receipt identifiers without storing credentials or
  unrestricted sensitive diagnostics.
- Keep protocol command types, response schemas, and capabilities out of the
  domain model until their Kenya-specific meanings are verified.

## Required evidence before enabling receipt issuance

Obtain from Tremol or the authorized Kenya distributor/customer:

1. The installed ZFP Lab Server version and command catalogue/XML response
   fixtures for `ReadStatus()`, Kenya invoice opening, `SellPLUfromExtDB()`,
   payment, and `CloseReceipt()`.
2. The exact Kenya invoice-open operator number/password mechanism and how it
   differs from generic `OpenReceipt(OperNum, OperPass)`.
3. The exact payment command, parameters/order, supported payment types, and
   tender/change behavior. The generic cash-close example is not sufficient.
4. The target fiscal unit model/serial-family and firmware versions, plus the
   vendor's compatibility statement for the supplied command/API revisions.
5. A reliable upstream payment source that provides invoice payment status,
   method, amount paid, currency, and provenance. The current Zoho invoice
   candidate mapper does not map payment transactions and must not infer them
   from invoice totals.
6. Written Kenya-specific confirmation of VAT/KRA classification, discounts,
   rounding, close metadata, cancellation, and reconciliation behavior. Device
   documentation alone cannot establish regulatory compliance.
7. A vendor-approved test procedure and representative sanitized request and
   response fixtures for **non-fiscal read-only** checks. Any later fiscal
   acceptance test needs explicit authorization, a designated test device or
   test mode, and a documented cleanup/reconciliation plan; it is not part of
   this phase.

The `FiscalizationRecord` currently has no QR-data field. Because this phase
does not enable an issuer and no validated server close response can yet be
persisted, the schema change is deferred rather than adding an unused,
speculative migration. Add nullable QR persistence in a PostgreSQL migration when a verified
close-response adapter is introduced. Real empty-database deployment remains
unverified until the opt-in local integration suite runs. No live hardware
operation was performed for this work.

## Local Tremol Node SDK review (2026-10-28)

A supplied SDK is present under `docs/JS/` as reference material, including
identical copies of `fp.js`, `fp_core.js`, and their declarations at the root,
under `js/fp/`, and under `use_this_folder_only_for_nodejs/`. The Node-specific
folder contains `nodejs_tremol_loader.js` and `nodejs_example.js`; `js/` also
contains browser demos and `jsconfig.json`. There is no package manifest or
license file in this supplied tree. The Node example names its external
dependencies as `xmlhttprequest` and `xmldom`; neither is installed in this
application. These files are documentation/reference material, not runtime
dependencies, and production code does not import from `docs/`.

The loader creates local `XMLHttpRequest` and `DOMParser` bindings from those
dependencies, then synchronously reads and directly `eval`s the provided core
and generated library paths. The core constructs both objects in `new FP()`.
Its transport calls `req.open(verb, url, false)`, so every request is
synchronous and has no SDK-level timeout. Under Node 24.19.0 in this
environment, `XMLHttpRequest`, `DOMParser`, and `window` are absent globals;
`navigator`, `atob`, and `btoa` exist. The loader's local bindings make the
first two available to evaluated source, but do not supply `window` for its
Base64 helpers. `IsOnAndroid()` reads `navigator.userAgent` without a guard.
The mocked VM test proves the loader and ordinary read command path execute
under Node when the two dependencies are injected; it does not test either
real package, an actual HTTP server, a device, or the timeout behavior.

The example and declarations also disagree with executable code. The example
calls `ServerSetSettings("http://localhost:4444/")`, while the declaration
requires both `ip` and `tcpport`; executable code accepts the missing second
argument, retains the URL, and leaves `ServerGetSettings().tcpport` undefined.
The supplied `fp_core.d.ts` also contains ambient `var` initializers with
function bodies (`FP` and `ServerError`), which are invalid TypeScript
declaration-file syntax and must not be included directly in the application's
typecheck.
The SDK's `do(commandName, ...)` builds a `<Command>` XML string and sends a
synchronous HTTP `POST` to the configured server root. It parses an XML `Res`
envelope, accepts only HTTP 200, and maps nonzero `Res Code` to
`Tremol.ServerError`; code 40 also parses `STE1`, `STE2`, and `FPLibErrorCode`
as hexadecimal. Other transport/parsing exceptions are wrapped as server
errors. This differs from the manual's §4.12 direct-command recipe, which
shows HTTP `GET /CommandName(...)`; the SDK's generated-library transport may
be a separate supported mode, but its compatibility with the target installed
LabServer must be confirmed.

### Transport contract comparison

| Path                                           | Source-established request                                                                                                                                                                                                                                   | Source-established response handling                                                                                                                                                                                                                                            | Evidence limit                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Manual direct interface (§4.12, printed p. 29) | `GET http://<host>:4444/<CommandName>(<name=value,...>)`; examples include command GET routes and `Settings(...)`.                                                                                                                                           | Manual examples show HTTP response XML: success with no data is `<Res Code="0"></Res>`, data is nested `<Res Name="..." Value="..." Type="..."/>`, and errors use a nonzero root `Code` plus an `Err` element. It documents result/error codes and status bytes in §4.11.       | This section explicitly covers operation “without using auto-generated library.” It does not describe the SDK POST wire contract or a request timeout.                                                 |
| Supplied SDK `do()`                            | Synchronous `POST` to the configured root (`http://<host>:4444/`); header `Content-Type: text/plain`; no body credentials or auth header; XML string body such as `<Command Name="ReadVersion"></Command>`. Optional `client` is added as a query parameter. | Accepts only HTTP 200. Reads `responseXML` or parses `responseText`; requires an XML `Res` code. Code 0 proceeds to typed nested result parsing; nonzero codes throw `ServerError`; code 40 reads hex `STE1`, `STE2`, and `FPLibErrorCode`. Synchronous XHR has no SDK timeout. | This request behavior is established by SDK source and the fake-XHR VM test. The manual does not state whether LabServer accepts this POST form, its content type, body envelope, or timeout behavior. |
| Application client                             | `GET /ReadStatus()`, `/ReadVersion()`, `/ReadCurrentReceiptInfo()`, or `/ReadLastAndTotalReceiptNum()`; `Accept` XML/text; bounded asynchronous fetch, correlation header, no body.                                                                          | Requires HTTP 2xx and an XML `Res` root with numeric `Code`; treats nonzero result as device error. It does not retain non-success response bodies in the thrown error.                                                                                                         | This is the intentionally retained application boundary. The HTTP method/path match the manual's direct-command route form, while the installed server's response behavior remains unverified.         |

The manual documents the direct GET mode and describes generated libraries, but
does not explicitly establish both HTTP modes. The SDK source proves only what
it sends, not what LabServer accepts. The documented response envelope and
the SDK's expected envelope are structurally consistent; this does not prove
that a POST receives that response from the installed LabServer.

At the command-definition level, the supplied generated SDK and Kenya CU
artifacts share names for the inspected operations, including `ReadStatus`,
`ReadVersion`, `OpenInvoiceWithFreeCustomerData`, `SellPLUfromExtDB`, and
`CloseReceipt`. The SDK wrappers serialize arguments as named XML `Arg`
elements in wrapper order; the Kenya protocol describes device command fields
and raw response data, not how HTTP clients encode those arguments. The
protocol's operator-credential prose/signature discrepancy for invoice opening
and its item-field prose/`zfpdef` discrepancy remain unresolved. SDK result
parsing expects a generic `Res Code` envelope with nested typed `Res` entries;
the Kenya document does not define those HTTP XML response fields. Thus names
and some definition fields align, but parameter serialization and HTTP response
mapping are not established as equivalent end to end.

`ServerFindDevice()` issues `GET /finddevice` and parses serial port and baud
rate. `ServerGetDeviceSettings()` issues `GET /settings`, compares returned
`defVer` with generated timestamp `2509041522`, and returns the configured
device password along with settings; consumers must never log or expose that
object unredacted. `ServerSetDeviceSerialSettings()` and
`ServerSetDeviceTcpSettings()` issue `GET /settings(...)` and change the
LabServer connection configuration. `ServerSetLog()` changes server logging.
These are writes/configuration actions and are not diagnostics. `do()` is a
generic unguarded command dispatcher, so direct exposure would bypass the
application's command allowlist.

The Node and browser examples call `PrintDiagnostics()`, but no supplied
`fp.js` or `fp.d.ts` defines it. The generated SDK instead exposes
`ReadDiagnostics()`, described as reading information about document-sending
functions. The example's `PrintDiagnostics` call therefore is not runnable
against these generated files; its comment claiming it prints a diagnostic
receipt is not supported by the library source. No such method is called by
the middleware. The Node example is CommonJS (`require`, `module.exports`),
while this application package is ESM (`"type": "module"`); it is not
directly executable in this repository without an intentional packaging
boundary. The example also changes device settings and then attempts the
undefined `PrintDiagnostics()` method, so it is not a safe smoke test.

The SDK declaration is `ServerSetSettings(ip: string, tcpport: number)`, while
its example calls `ServerSetSettings("http://localhost:4444/")`. The runtime
accepts an omitted second argument, but that conflicts with the declaration
and should not be copied as a typed integration contract. The SDK exposes
`IsCompatible()` against definitions reported by its server; this does not
prove compatibility with a particular Kenya G03 firmware. The package's
version metadata alone also does not establish the installed LabServer build.

The four application read commands remain the only device commands allowed by
the HTTP adapter. The controlled SDK harness uses fake XHR/XML dependencies and
verifies `ServerFindDevice()`, compatibility metadata parsing, and the
read-only `ReadVersion()` request without opening a socket. It confirms the
SDK's basic source can execute in Node with those dependencies supplied, but
does not establish that the published dependency versions, SDK transport, or
LabServer installation work in deployment. The SDK remains unwired because
its synchronous unbounded transport is incompatible with the middleware's
bounded asynchronous transport, its generic dispatcher bypasses the existing
allowlist, and Kenya G03/LabServer compatibility is unverified. No physical
device calls or fiscal mutations were made.

### Smallest safe installed-server acceptance check

Run only in an authorized maintenance window against a dedicated LabServer
already connected to the designated test G03 or vendor-authorized read-only
bench setup. Record the installed LabServer version/definitions and device
model/firmware from approved local records first. Do not call `ServerFindDevice`
for this check; the manual says discovery can scan ports and cause delay. Do not
call a settings setter, `ApplyClientLibraryDefinitions`, `PrintDiagnostics`, or
a generic SDK command supplied by an operator.

1. With the application's existing client, issue exactly one `GET
/ReadVersion()` and record only HTTP status, result code, and a sanitized
   version value.
2. Against the same LabServer origin, use a bounded HTTP client to send the
   source-equivalent SDK request: `POST /`, `Content-Type: text/plain`, body
   `<Command Name="ReadVersion"></Command>`. Apply a short request timeout and
   an overall process deadline; record only HTTP status, error category or
   result code, and sanitized version. Do not invoke the SDK's synchronous
   `do()` method, call a settings setter, or log raw XML.
3. Confirm both responses have `Res Code="0"` and the same version. Ask Tremol
   to confirm the SDK definitions timestamp, LabServer definitions version,
   and installed G03 firmware are a supported combination. Stop on a rejected
   method, timeout, nonzero code, or differing result. Do not automatically
   retry or switch modes in that run.

This check establishes only whether the two source-documented request shapes
work for this read command in that specific installation. The bounded POST
probe checks the SDK's wire representation, not its synchronous XHR runtime.
It does not establish receipt issuance safety, POST support for other commands,
or production compatibility.
