# EATER - ULTIMATE FOOD DELIVERY ECOSYSTEM (Swiggy/Zomato Clone Blueprint)

## 🏗️ ENTERPRISE TECH STACK
- **Frontend (Web/Mobile):** React.js (Vite), React Native / Expo (Future Mobile Apps)
- **Backend:** Node.js, Express.js
- **Database:** PostgreSQL / SQLite (via Prisma ORM)
- **Real-Time Engine:** WebSockets (Socket.io) for Live Order Tracking
- **Location & Maps:** Google Maps API (Distance Matrix, Directions, Geocoding)
- **Payments:** Razorpay / Stripe Integration
- **Notifications:** Firebase Cloud Messaging (FCM) / Push Notifications

---

## ⚠️ STRICT RULES FOR CURSOR AI (CRITICAL - DO NOT BREAK)
1. **NO MOCK DATA:** Never use fake adapters. All data must come from the real backend (`http://localhost:5000/api`) and real database schema.
2. **PRESERVE CORE LOGIC:** Do NOT delete existing features (Admin payouts, UTR tracking, warning banners, Net payout math).
3. **MODULAR ARCHITECTURE:** Always build scalable, separate components (`src/components/`, `src/pages/`). No monolithic 1000-line files.
4. **ONE PHASE AT A TIME:** Do NOT execute the whole plan at once. Finish one phase, wait for user validation, and then proceed.

---

## 🗺️ THE "KACHA CHITHA" (COMPLETE ROADMAP)

### PHASE 1: UI & Architecture Foundation (Current Phase)
- **1.1 Admin Panel Modularization:** Split `Admin.jsx` into `Dashboard`, `Users`, `Restaurants`, `Riders`, `Ledger/Transactions`, `Coupons`.
- **1.2 Partner Panel Modularization:** Split `Partner.jsx` into `LiveOrders` (KOT View), `MenuManager`, `Finance`, `Promotions`.
- **1.3 Rider Panel Modularization:** Split `Rider.jsx` into `ActiveDeliveries`, `Earnings`, `Profile/KYC`.

### PHASE 2: Advanced Restaurant (Partner) App
- **2.1 Complex Menu System:** Add Categories, Sub-categories, Add-ons (Extra Cheese, Dips), Variants (Half/Full/Family pack), and Out-of-stock toggles.
- **2.2 KOT (Kitchen Order Ticket):** Auto-print formatting for kitchen staff.
- **2.3 Food Preparation Timer:** Dynamic preparation time logic (15 mins, 30 mins) based on order size.
- **2.4 Business Metrics:** Conversion funnel (Views -> Cart -> Orders), Item-wise sales report.

### PHASE 3: Advanced Rider (Fleet) App
- **3.1 Live Tracking & GPS:** Implement Background Geolocation to track rider coordinates updating every 5 seconds via WebSockets.
- **3.2 Earnings Engine:** Per-delivery payout + Distance pay + Wait-time penalty + Daily Incentives/Milestones.
- **3.3 Floating Cash Limit:** If a rider collects too much COD (Cash on Delivery), block their account until they deposit it back to the platform.
- **3.4 Duty Toggle:** Online/Offline shift logging.

### PHASE 4: Advanced Customer (User) App
- **4.1 Smart Discovery:** Geolocation-based restaurant listing (show restaurants only within 7-10 KM radius).
- **4.2 Search & Filters:** Search by Dish, Cuisine, or Restaurant. Filters: Veg Only, Rating 4.0+, Fast Delivery.
- **4.3 Advanced Cart:** Multi-restaurant cart blocking (Customer can only order from one restaurant at a time), Bill breakdown (Taxes, Delivery Fee, Surge Fee, Platform Fee).
- **4.4 Live Order Map:** "Your food is being prepared" -> "Rider is on the way" (Moving car icon on map).
- **4.5 Wallet & Loyalty:** Fresto Cash (Wallet), Saved Cards, Favorite Addresses (Home/Work/Other).

### PHASE 5: Super Admin & Operations Control (The Brain)
- **5.1 Zone & Polygon Management:** Draw delivery zones on maps (Geofencing).
- **5.2 Surge Pricing Engine:** "Rain Mode" or "High Demand Mode" - Automatically increase delivery fees if orders > available riders.
- **5.3 Commission Matrix:** Variable commission rates (e.g., 15% for normal restaurants, 10% for premium partners).
- **5.4 KYC & Onboarding:** Document verification workflow (FSSAI, Aadhar, Pan, RC, Driving License) with Approve/Reject/Re-upload triggers.
- **5.5 Customer Support CRM:** Chatbot integration and Ticket raising system (e.g., "Food was spilled", "Wrong item delivered") with automated refund wallet top-ups.

### PHASE 6: Production Infrastructure & Security
- **6.1 Data Security:** JWT Authentication, OTP-based login (Twilio/Fast2SMS). **Implemented (dev):** `POST /api/auth/send-otp` + `verify-otp` with in-memory OTP store; admin phone(s) via `ADMIN_PHONE` env (default `8299393771`); OTP must match sent code (same length as `OTP_CODE_LENGTH`); customer USER can register on first verify.
- **6.2 Media Storage:** AWS S3 buckets for storing Dish Images, Restaurant Banners, and KYC documents.
- **6.3 Rating & Review System:** Two-way rating (Customer rates Restaurant/Rider, Rider rates Customer).
## 🚀 ADVANCED BUSINESS RULES (NEW CORE LOGIC)
1. **Weekly Batch Payouts:** Shift from per-order settlement to Weekly Ledger. Admin UI should show "Weekly Pending Dues" with a single "Settle Week" button + UTR input per vendor/rider.
2. **Fleet-Linked Auto Availability:** A restaurant's `isDeliverable` status strictly depends on active riders. If `active_riders_within_5km == 0`, restaurant automatically shows as "Unavailable" to customers. 
3. **Strict Single-Vendor Cart:** The customer frontend cart MUST block adding items from multiple restaurants. Show a "Clear Cart & Add" warning modal if they try to add an item from a second restaurant.
4. **High-Alert Web-Audio KOT:** The Partner and Rider dashboards must include an `<audio>` alarm that loops loudly when a new order status is 'PENDING', stopping only when ACCEPTED or REJECTED.
5. **AI Menu Digitization (OCR):** The Partner Panel must have an "AI Auto-Menu Upload" feature (UI for now) where partners can upload a Menu Image/PDF. (Later, this will connect to a Vision LLM to auto-extract items).
6. **Smart Order ETA:** Every order must display an ETA (Estimated Time of Arrival) based on a dynamic calculation (`prep_time` + `delivery_time`). 
7. **Predictive Dispatch & Duty Lock:** When an order status is `PREPARING`, nearest riders receive a "Standby: Order Preparing Near You" alert. Crucially, if a rider has a standby alert or an active delivery, their "Online/Offline" toggle MUST be disabled (locked) to prevent them from abandoning the shift.
8. **Bulk AI Menu Digitization:** The Partner AI Menu upload must support multiple files at once (`multiple` attribute). Partners can upload several images/PDFs together, and the UI should display the list of selected files before processing.
9. **Customer Live Geolocation:** The Customer App must have a "📍 Use Current Location" button at checkout/address selection. It should use the browser's native `navigator.geolocation` API to fetch exact Latitude & Longitude for pin-point delivery accuracy.

---
**Dear Cursor AI / Agent:** Acknowledge this ultimate blueprint. Reply with "ULTIMATE EATER BLUEPRINT RECEIVED" and wait for the developer to issue the first command to start execution.