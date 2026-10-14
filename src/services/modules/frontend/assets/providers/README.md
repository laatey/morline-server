# Provider logos

Copy the SVG files here into `morline-main/src/assets/providers/`.
`node scripts/icons.js <this folder> <src/assets/stack>` lists what is still missing.

Rules for every file:
- One square mark, not a wordmark (it is shown at 14 x 14 px). Use the company's icon/logomark.
- Square `viewBox`, no embedded raster images, no external references, under about 4 KB.
- File name is exactly the key below, lower case.
- Use official brand assets or Simple Icons (simpleicons.org, CC0 files; the logos themselves remain trademarks of their owners). Do not recolour or distort them beyond the monochrome rule below.
- Monochrome marks (resend, openai, anthropic): a single solid shape in any colour. The app draws them in the current text colour, so they work in light and dark mode.

| File | Used for |
| --- | --- |
| resend.svg | Resend email (monochrome) |
| postmark.svg | Postmark email |
| sendgrid.svg | SendGrid email |
| anthropic.svg | Claude (Anthropic) (monochrome) |
| openai.svg | OpenAI (monochrome) |
| gemini.svg | Google Gemini |
| stripe.svg | Stripe payments |
| paystack.svg | Paystack payments |
| s3.svg | S3-compatible storage (Amazon S3 mark) |
| twilio.svg | Twilio SMS |

Already in `src/assets/stack/` and reused as-is: `postgresql.svg`, `mongodb.svg`, `redis.svg`.
