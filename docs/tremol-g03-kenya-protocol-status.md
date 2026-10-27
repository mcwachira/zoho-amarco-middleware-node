# Tremol G03 Kenya protocol verification status

**Status: read-only protocol foundations implemented; receipt issuance remains disabled.**
The repository now contains the Kenya control-unit protocol and ZFP Lab Server
manual. The facts below are limited to what those documents explicitly state.
The installed server/firmware version, command-specific XML result mapping, and
vendor-confirmed hardware behavior remain unverified.

## Evidence inventory

| Evidence                                                                                                                    | Version/date in repository                                                   | What it establishes                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/protocol_description_KE_CU_2509041522.pdf`, §2.2.1, p. 10                                                             | Filename encodes `2509041522`; title page revision/date not established here | `ReadStatus` output is six status bytes; defines ST0-ST5 flag bits and meanings.                                                                                           |
| `docs/protocol_description_KE_CU_2509041522.pdf`, §§2.2.2, 2.5.2, 2.5.5, 2.5.7, pp. 10, 23, 26-29                           | Same local PDF                                                               | Documents `ReadVersion`, invoice open, `SellPLUfromExtDB`, and `CloseReceipt` names/fields; does not provide the HTTP XML serialization for those result fields.           |
| `docs/Manual.pdf`, §§4.1, 4.12, pp. 8, 29                                                                                   | Revision/date not established from local copy                                | ZFP Lab Server uses synchronous HTTP GET command requests; gives XML `Res` success/error envelope examples and a generic `<Res Name Value Type>` data-result example.      |
| `src/infrastructure/device/tremol-zfplabserver-client.ts`                                                                   | Application implementation                                                   | Implements read-only GET requests, validates `ReadVersion`, leaves status flags unknown, and parses documented close-response metadata without executing receipt commands. |
| `src/infrastructure/device/tremol-device-diagnostics.ts`                                                                    | Application implementation                                                   | Uses `ReadVersion()` for endpoint connectivity only; this result is not a readiness decision.                                                                              |
| `src/infrastructure/device/tremol-receipt-command-builder.ts` and `src/infrastructure/device/zoho-tremol-receipt-mapper.ts` | Application implementation                                                   | Build a non-executable proposal only; they do not call the device.                                                                                                         |
| `prisma/postgresql/schema.prisma`, `prisma/sqlserver/schema.prisma`, repository mappers                                     | Current schema and source                                                    | Receipt persistence currently stores CU receipt number and issue time, but no QR data.                                                                                     |

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
| `ReadStatus()`                         | §2.2.1, p. 10: six raw status bytes; individual flag meanings and byte/bit locations are listed.                                                                                                                                                                                                                                                                       | §4.12, p. 29: generic named results use `Res`/`Name`/`Value`/`Type`; no command-specific serialization is shown. `s_ReadStatus.xml` specifies raw `<StatusBytes[6]>`, not the server's XML mapping.                          | Parser validates the generic result envelope and returns all flags and readiness as `unknown`; it does not assume `ST0`-`ST5` XML names or decimal encoding.                                                                                              |
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
error. `readStatus()` validates the generic envelope and leaves every status
flag unknown because no supplied source maps the Kenya raw status bytes to
ZFPLabServer XML fields.

The application invokes `ReadVersion()` from
`TremolDeviceDiagnostics.checkConnection()`. The server constructs one client
at startup and exposes that check through `/health/device`. The client checks
the documented `Version` result name and its 30-character limit. A successful
response means only that the configured endpoint returned a parseable version;
it does not verify the device model, firmware compatibility, readiness, or
ability to issue a compliant receipt. A captured/sanitized response from the
target ZFP Lab Server version, or a vendor schema mapping all six bytes and
their encoding, is needed before interpreting status flags. Readiness is
never reported as true.

The client serializes requests only within a single client instance. It has no
cross-process lock or device-wide coordination. The request abort timeout
rejects the pending promise, but cannot prove whether the server or device
processed a request before the response was lost. This is not a safe basis for
retrying a potentially state-changing command. Although the current allow-list
is named “read commands,” their read-only nature and repeat safety remain
unverified for the Kenya control unit until the vendor confirms them.

HTTP errors and nonzero result codes retain the response body on internal error
objects. The health diagnostic response reduces failures to an error name and
does not return that body or the configured endpoint. Do not expose raw
response content in future public diagnostics without a reviewed redaction
policy.

| Existing operation                                     | Source-level effect                                       | Request/response behavior in code                                         | Protocol status / repeat safety                                                           |
| ------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ReadVersion()` via `/health/device`                   | Reads version information per protocol §2.2.2             | HTTP GET; XML `Res Code="0"` accepted; body otherwise retained internally | Read operation documented; repeat behavior not specified                                  |
| `ReadStatus()`                                         | Reads six status bytes per protocol §2.2.1                | Same GET; validates envelope and leaves flags unknown                     | Read operation documented; HTTP field serialization and repeat behavior need confirmation |
| `ReadCurrentReceiptInfo()`                             | Reads current receipt information per protocol §2.6.6     | Same GET and generic XML envelope                                         | Read operation documented; repeat behavior not specified                                  |
| `ReadLastAndTotalReceiptNum()`                         | Reads receipt-number information per protocol §2.6.5      | Same GET and generic XML envelope                                         | Read operation documented; repeat behavior not specified                                  |
| `OpenInvoiceWithFreeCustomerData(...)` in receipt plan | Locally generated text only; plan has `executable: false` | No transport call or device response                                      | Unverified; must not be sent                                                              |
| `SellPLUfromExtDB(...)` in receipt plan                | Locally generated text only; plan has `executable: false` | No transport call or device response                                      | Unverified; must not be sent                                                              |
| `Subtotal()` in receipt plan                           | Locally generated text only; plan has `executable: false` | No transport call or device response                                      | Unverified; must not be sent                                                              |

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

| Capability                                       | Status                | Local implementation evidence                                                                                                | Evidence required                                                                                                                                                                                |
| ------------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Device identification and firmware compatibility | Unverified            | `ReadVersion()` is parsed, but no compatibility matrix is applied                                                            | Official G03 Kenya model identification and firmware compatibility document; vendor confirmation of returned version semantics                                                                   |
| Connection and transport behavior                | Unverified            | Configurable HTTP(S) base URL, GET, timeout, and mock transport                                                              | Versioned ZFP Lab Server interface document covering transport, URL, authentication, TLS, ports, timeouts, and connection lifecycle                                                              |
| Read-only status and diagnostics                 | Partially implemented | `ReadStatus()` parses ST0-ST5 bit flags; readiness remains unknown. `ReadVersion()` is connectivity only.                    | Installed-server status XML fixture and vendor-confirmed interpretation/readiness criteria; firmware compatibility                                                                               |
| Receipt opening                                  | Blocked               | `OpenInvoiceWithFreeCustomerData(...)` appears only in non-executable plan.                                                  | Resolve the mismatch between omitted operator parameters in the protocol signature and operator credentials in its prose; establish installed server command signature and credential mechanism. |
| Customer information                             | Unverified            | Planner renders customer fields into a string                                                                                | Official field names, limits, optionality, encoding, PIN/exemption requirements, and validation rules                                                                                            |
| Item registration and line entry                 | Unverified            | `SellPLUfromExtDB(...)` appears only in non-executable plan                                                                  | Official Kenya contract for item lookup/registration, line entry, field semantics, unit/HS data, and error responses                                                                             |
| Tax/VAT classification                           | Unverified            | Planner allows class `A`; no verified mapping exists                                                                         | Official device and KRA/eTIMS mapping guidance for the target device, firmware, registration, and applicable Kenyan tax rules                                                                    |
| Discounts and totals                             | Unverified            | Optional discount percentage can be rendered; no total is calculated or cross-checked                                        | Official discount/addition rules, rounding and total calculation behavior, and corresponding response evidence                                                                                   |
| Payment handling                                 | Blocked               | Not implemented.                                                                                                             | Exact Kenya operation name, argument order, payment-type mapping, tender/change semantics, and error semantics.                                                                                  |
| Receipt closure                                  | Blocked               | Not implemented. Kenya protocol names `CloseReceipt()` but server response mapping is unavailable.                           | Installed-server close response fixture/contract and completion semantics.                                                                                                                       |
| Receipt identifiers and returned fiscal metadata | Partially verified    | Kenya protocol documents a close output with invoice number and QR code; neither is parsed/persisted from a device response. | Exact ZFP XML field names, encoding, and close confirmation semantics.                                                                                                                           |
| Cancellation or void behavior                    | Unverified            | Not implemented                                                                                                              | Official Kenya-specific cancellation/void authority, allowed state/time windows, commands, and audit results                                                                                     |
| Busy responses and command serialization         | Unverified            | In-process queue serializes calls in one client instance                                                                     | Official busy/result-code definitions and device-wide concurrency rules, including multiple process/client behavior                                                                              |
| ACK/NACK and documented response types           | Unverified            | Parser expects only `Res` with numeric `Code`; does not parse a command-specific schema                                      | Versioned response catalogue for success, warnings, errors, ACK/NACK, partial results, and firmware variations                                                                                   |
| Timeout/disconnected-response behavior           | Unverified            | Abort signal rejects the HTTP call; no device-state determination                                                            | Vendor description of server/device behavior when a connection drops before, during, or after command execution                                                                                  |
| Determine issuance after a lost response         | Unverified            | No reconciliation operation or authoritative check is implemented                                                            | Vendor-approved inquiry/reconciliation procedure that can identify the exact receipt without reissuing                                                                                           |
| Recovery and reconciliation                      | Unverified            | Application fiscalization service can preserve `OutcomeUnknown`; device-specific reconciliation is absent                    | Documented safe recovery runbook and authoritative evidence sources, including operator actions and audit requirements                                                                           |
| Character encoding and monetary formats          | Unverified            | JavaScript strings and decimal validation are used in a plan                                                                 | Official character set/escaping, maximum lengths, currency representation, decimal scale, rounding, negative values, and overflow behavior                                                       |

The protocol field names/bit meanings and generic ZFP HTTP/XML envelope are
documented; installed-server compatibility and command-specific serialization
are not vendor-confirmed. No capability is hardware-verified.

## Safe integration boundary

The processing path is wired through request registration, atomic claim,
stored-snapshot validation, device boundary, and durable outcome persistence.
The production server constructs the processing service without a device
adapter and with issuance disabled. Its guard runs before database lookup or
claim, and requires explicit verified payment-source, tax-rule, and
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
speculative migration. Add nullable QR persistence with matching PostgreSQL
and SQL Server migrations when a verified close-response adapter is introduced.
The SQL Server migration baseline is present with the profile/snapshot
migrations; real empty-database deployment remains unverified until the
opt-in local integration suite runs. No live hardware operation was performed
for this work.
