# GTN Binary Options

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `FLW_SECRET_KEY` (must begin `FLWSECK_TEST-`) and `FLW_WEBHOOK_HASH` from your Flutterwave sandbox account. Keep these server-side; never put them in the frontend.
3. Keep `FLW_ENV=sandbox`. Set `APP_BASE_URL` to the app URL and configure Flutterwave's webhook URL as `{APP_BASE_URL}/api/cashier/flutterwave/webhook`, using the same webhook hash.
4. Run `npm install`, then `npm start`, and open `http://localhost:4000`.

M-Pesa deposits use the account's Kenyan phone number and require the customer to approve Flutterwave's prompt on their handset. Never collect the M-Pesa PIN in this app. Card payments use Flutterwave-hosted checkout. Withdrawals are sent to the registered Kenyan M-Pesa number. Balances change only after provider verification.

This in-memory build is sandbox-only; live payments are intentionally disabled. Use a persistent transaction store and complete production payout/webhook reconciliation before enabling real money. Run the mocked payment integration checks with `npm test`; they do not call Flutterwave or move money.
