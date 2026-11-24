# CampusLink v3 — Complete Production App (Admin, User, Client, Freelancer)

## Flat-Folder Structure (Zero Subfolder Upload Issues!)
Every file sits directly in one folder (`server.js`, `db.js`, `schema.sql`, `index.html`, `package.json`, `render.yaml`, `README.md`) so you can upload all 7 files to GitHub in one single drag-and-drop.

## Roles Built In
- **Admin**: Automatically granted to the **first account you register** (or lock it to your phone via Render env var `ADMIN_PHONE`). Includes a dedicated **Admin** tab to filter universities, view live stats, suspend/unban spam users, and moderate any job or delivery pool.
- **Client**: Post jobs with university, year, and location; privately review all bids sorted cheapest first; accept one bid to unlock WhatsApp/phone; mark jobs completed.
- **Freelancer**: Filter jobs by university and category; submit or update private bids (other freelancers cannot see your bid); unlock client phone when chosen.
- **User (Cart Pools)**: Start or join university/hostel free-delivery pools; unlock starter phone once you join; copy 1-tap WhatsApp invite messages.

## Deploy on Render (3 Steps)
1. Upload all 7 files from `campuslink-v3/` to your GitHub repo (`girisggarg-art/campuslink`).
2. On Render → **New + → Web Service** → connect `campuslink` (`Build Command`: `npm install`, `Start Command`: `node server.js`, Plan: `Free`).
3. Add Environment Variable **`DATABASE_URL`** = your Neon PostgreSQL string (and optionally **`ADMIN_PHONE`** = your 10-digit phone number), then click **Create Web Service**.
