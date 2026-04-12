# Restaurant WhatsApp Ordering + Review System

Production-ready MVP for small restaurants to accept WhatsApp orders, collect payments, send status updates, and gather item-level reviews.

## Stack

- Backend: NestJS + Prisma + PostgreSQL
- Frontend: React + Vite + Tailwind CSS
- Messaging: WhatsApp Business Platform API
- Payments: Razorpay payment links

## Monorepo Structure

- `apps/api`: NestJS backend, Prisma schema, WhatsApp webhook, Razorpay integration
- `apps/dashboard`: React admin dashboard for menu, orders, and reviews

## Quick Start

1. Run `npm install`
2. Copy `apps/api/.env.example` to `apps/api/.env`
3. Copy `apps/dashboard/.env.example` to `apps/dashboard/.env`
4. Run `npm run prisma:generate`
5. Run `npm run prisma:migrate`
6. Run `npm run prisma:seed`
7. Run `npm run dev:api`
8. Run `npm run dev:dashboard`

Backend default: `http://localhost:4000`
Dashboard default: `http://localhost:5173`

## Local Development (WhatsApp Webhooks)

To test WhatsApp webhooks locally, you must expose your local backend to the internet. Run the following command in a separate terminal:

```bash
npx ngrok http 4000
```

### Configuring Meta WhatsApp Webhook

1.  Copy the forwarding HTTPS URL provided by ngrok (e.g., `https://xxxx-xxxx.ngrok-free.app`).
2.  Go to your [Meta App Dashboard](https://developers.facebook.com/apps).
3.  Navigate to **WhatsApp** > **Configuration**.
4.  Under **Webhook**, click **Edit**.
5.  **Callback URL**: `[YOUR_NGROK_URL]/whatsapp/webhook/[tenant-id]`
    - Replace `[tenant-id]` with the ID of the restaurant/tenant you are testing (e.g., `restaurant-tenant`).
    - Example: `https://xxxx-xxxx.ngrok-free.app/whatsapp/webhook/restaurant-tenant`
6.  **Verify Token**: Use the value of `WHATSAPP_VERIFY_TOKEN` from your `apps/api/.env` (default: `orderthru_verify_123`).
7.  Click **Verify and Save**.
8.  Under **Webhook fields**, click **Manage** and subscribe to `messages`.

## WhatsApp Commands

- `menu`
- `order <item>`
- `status`
- `reviews <item>`
- `help`

## Launch Checklist

- Configure production PostgreSQL
- Add Meta WhatsApp webhook URL and verify token
- Add Razorpay live keys
- Use a secure JWT secret
- Rotate the seeded admin password after first login
