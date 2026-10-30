# Roast Room: public, paid edition

The same room, open to anyone on the web, one roast per payment.

- `PUBLIC_MODE=1` turns it on. Seats show as archetypes (for example "The First-Principles Builder"), drawn as simple busts, with a disclaimer that they are modelled on public work and are not the real people.
- Every roast is paid first. The room's **Book my roast** button opens your Paystack page. Paystack sends the visitor back to the room with a payment reference; the server confirms it with Paystack (₦15,000 or $10 minimum) before the council starts. Each payment starts one roast. A refresh picks the same roast back up.
- Councils run on the Anthropic API (`ANTHROPIC_API_KEY`), Sonnet for the seats and Opus for the Chair. A full council costs roughly $0.50 to $1.00 in API usage.
- Up to `MAX_RUNNING` councils run at once (default 3). Past sessions are not listed publicly.
- `ROAST_ADMIN_CODE`: open the room with `?code=<your word>` to run a roast without paying (for testing and demos).

## Go live (about 15 minutes)

1. **Anthropic API key**: console.anthropic.com ▸ API keys ▸ Create key. Add credit (start with $20) and set a monthly spend limit.
2. **Paystack page**: Payment Pages ▸ Create page ▸ One-time, ₦15,000, "Roast my idea". Set **Redirect after payment** to your room address (step 4).
3. **Render**: render.com ▸ New ▸ Blueprint ▸ this repo, branch `public-web`. Paste the keys it asks for. Starter plan (about $7 a month).
4. **Address**: Render gives you `https://roast-room-xxxx.onrender.com`. Optional: add `roast.oluwaseyiashiru.com` under Settings ▸ Custom domains and add the CNAME record it shows at your domain provider.
