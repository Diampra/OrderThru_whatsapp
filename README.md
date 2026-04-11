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
