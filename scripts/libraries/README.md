# Reviewed Pine libraries

These are unmodified, public TradingView library sources at the **exact major
versions requested by the scanners**, downloaded 6 November 2026. Each source
retains TradingView's copyright and MPL-2.0 header. The manifest records its
publication, exact source endpoint, version, page and SHA-256. Git preserves the
original line endings. License: https://mozilla.org/MPL/2.0/.

`TradingView/ta/7`–`14` depend on `TradingView/RelativeValue/2` or `/3`.
Chart workers and scanner workers use this same verified store. Neither resolves
imports over the internet or substitutes `last` / latest. An authenticated chart
request must specify both the import path and its expected SHA-256.

The registry appends a comment containing the complete dependency lock to the
executable source. Existing source/policy hashes therefore include nested library
versions. Archived sources retain their lock; missing, changed or unlocked imports
fail explicitly. Ordinary scanners with no imports retain their original hash.
The compatibility CLI pins new research inputs through the same store.

To add a library, inspect the original publication and its license, fetch its
numeric version, verify the response's name, library kind, open-source access and
version, retain the original source and record its hash. Recursively review all
imports. Test actual consumers and closed-bar behavior before enabling account
trading. Adding a dependency is not evidence of strategy profitability or correct
external-data coverage. Never replace existing entries silently.
