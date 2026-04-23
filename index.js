import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

/////////////////////////////////////////
// 🕐 TIMEZONE HELPER (UTC+7 Thailand)
// Server (Render) runs in UTC. This helper returns the correct
// start-of-day and end-of-day in UTC that correspond to "today in Thailand".
/////////////////////////////////////////
function getTodayRangeUTC() {
  const TZ_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7

  // Current time shifted to Thailand "local"
  const nowTH = new Date(Date.now() + TZ_OFFSET_MS);

  const y = nowTH.getUTCFullYear();
  const m = nowTH.getUTCMonth();
  const d = nowTH.getUTCDate();

  // Thailand date string "YYYY-MM-DD" — used for order_date column
  const todayTH = `${y}-${String(m + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

  // UTC equivalents of Thailand midnight boundaries
  const start = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - TZ_OFFSET_MS);
  const end   = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - TZ_OFFSET_MS);

  return { start, end, todayTH };
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/////////////////////////////////////////
// 🔐 CONNECT SUPABASE
/////////////////////////////////////////
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const PORT = process.env.PORT || 3000;

/////////////////////////////////////////
// 🟢 GET MENU — sorted by price ASC
/////////////////////////////////////////
app.get("/menu", async (req, res) => {
  const { data, error } = await supabase
    .from("menu")
    .select(`
      id,
      name,
      price,
      category_id,
      categories(name)
    `)
    .order("price", { ascending: false }); // FIX: sort by price ascending

  if (error) return res.status(500).json(error);

  const formatted = data.map(item => ({
    id: item.id,
    name: item.name,
    price: item.price,
    category_id: item.category_id,
    category_name: item.categories?.name
  }));

  res.json(formatted);
});

/////////////////////////////////////////
// 🟢 ADD MENU
/////////////////////////////////////////
app.post("/menu", async (req, res) => {
  const { name, price, category_name } = req.body;

  const { data: category } = await supabase
    .from("categories")
    .select("id")
    .eq("name", category_name)
    .single();

  if (!category) return res.status(400).json({ error: "Category not found" });

  const { error } = await supabase.from("menu").insert([
    { name, price, category_id: category.id }
  ]);

  if (error) return res.status(500).json(error);

  res.json({ message: "เพิ่มสำเร็จ" });
});

/////////////////////////////////////////
// ✏️ UPDATE MENU
/////////////////////////////////////////
app.put("/menu/:id", async (req, res) => {
  const { id } = req.params;
  const { name, price, category_name } = req.body;

  const { data: category } = await supabase
    .from("categories")
    .select("id")
    .eq("name", category_name)
    .single();

  if (!category) return res.status(400).json({ error: "Category not found" });

  const { error } = await supabase
    .from("menu")
    .update({ name, price, category_id: category.id })
    .eq("id", id);

  if (error) {
    console.error(error);
    return res.status(500).json(error);
  }

  res.json({ message: "updated" });
});

/////////////////////////////////////////
// 🟢 DELETE MENU
/////////////////////////////////////////
app.delete("/menu/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("menu").delete().eq("id", id);
  res.json({ error });
});

/////////////////////////////////////////
// 🟢 CREATE ORDER
// order_number is generated atomically inside Postgres via RPC
// to prevent race conditions (two simultaneous orders getting the same number).
//
// ⚠️  Run this SQL in Supabase SQL Editor ONCE before deploying:
//
// CREATE OR REPLACE FUNCTION get_next_order_number(day_start timestamptz, day_end timestamptz)
// RETURNS int LANGUAGE plpgsql AS $$
// DECLARE
//   next_num int;
// BEGIN
//   SELECT COUNT(*) + 1
//     INTO next_num
//     FROM orders
//    WHERE created_at >= day_start
//      AND created_at <= day_end
//   FOR UPDATE;          -- row-level lock prevents concurrent reads
//   RETURN next_num;
// END;
// $$;
/////////////////////////////////////////
app.post("/order", async (req, res) => {
  const { items } = req.body;

  try {
    const { todayTH } = getTodayRangeUTC();
    const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

    // ✅ Single atomic Postgres call: lock + count + insert in one transaction
    // Node sends todayTH (Thailand date) directly — no timezone math in Postgres
    const { data: order, error: orderError } = await supabase.rpc(
      "create_order_atomic",
      {
        p_today: todayTH,
        p_total: total,
        p_items: items.map(i => ({
          menu_id:    i.menu_id,
          quantity:   i.quantity,
          unit_price: i.price
        }))
      }
    );

    if (orderError) throw orderError;

    console.log("RAW:", JSON.stringify(order));

    // *** DEBUG: ดูว่า order จริงๆ เป็นอะไร ***
    console.log("RPC raw result:", JSON.stringify(order));

    // Supabase บางครั้ง return array แทน object เดี่ยว
    const raw = Array.isArray(order) ? order[0] : order;
    const result = typeof raw === "string" ? JSON.parse(raw) : raw;

    console.log("Parsed result:", result);

    res.json({ order_id: result.id, order_number: result.order_number });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "สร้างออเดอร์ไม่สำเร็จ" });
  }
});

/////////////////////////////////////////
// 🟢 GET ORDERS — today only, pending first then newest first
// FIX: Filter by joining orders table correctly via a two-step query
//      (Supabase JS does not support WHERE on joined tables via .gte on nested columns)
/////////////////////////////////////////
app.get("/orders", async (req, res) => {
  try {
    // FIX: Use todayTH (Thailand date string) directly — no UTC slice bug
    const { todayTH } = getTodayRangeUTC();

    // Step 1: Get today's orders using order_date column
    const { data: todayOrders, error: ordersError } = await supabase
      .from("orders")
      .select("id, order_number, payment_status, created_at")
      .eq("order_date", todayTH);

    if (ordersError) throw ordersError;
    if (!todayOrders || todayOrders.length === 0) return res.json([]);

    const orderIds = todayOrders.map(o => o.id);

    // Step 2: Get order_items for those orders
    const { data: items, error: itemsError } = await supabase
      .from("order_items")
      .select(`
        order_id,
        quantity,
        unit_price,
        menu:menu_id(name)
      `)
      .in("order_id", orderIds);

    if (itemsError) throw itemsError;

    // Step 3: Build a lookup map for orders
    const orderMap = {};
    todayOrders.forEach(o => {
      orderMap[o.id] = o;
    });

    // Step 4: Flatten into the shape the frontend's groupOrders() expects
    const result = items.map(item => ({
      order_id:       item.order_id,
      order_number:   orderMap[item.order_id]?.order_number,
      menu_name:      item.menu?.name,
      quantity:       item.quantity,
      unit_price:     item.unit_price,
      payment_status: orderMap[item.order_id]?.payment_status,
      created_at:     orderMap[item.order_id]?.created_at
    }));

    // Step 5: Sort — pending first, then newest order_id first
    result.sort((a, b) => {
      if (a.payment_status !== b.payment_status) {
        return a.payment_status === "pending" ? -1 : 1;
      }
      return b.order_id - a.order_id;
    });

    res.json(result);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "โหลดออเดอร์ไม่สำเร็จ" });
  }
});

/////////////////////////////////////////
// 🟢 PAYMENT
/////////////////////////////////////////
app.post("/pay", async (req, res) => {
  try {
    const { order_id, method } = req.body;

    const { error: updateError } = await supabase
      .from("orders")
      .update({
        payment_status: "success",
        payment_method: method,
        order_status: "paid"
      })
      .eq("id", order_id);

    if (updateError) throw updateError;

    const { error: payError } = await supabase
      .from("payments")
      .insert([{
        order_id,
        method,
        status: "success",
        paid_at: new Date()
      }]);

    if (payError) throw payError;

    res.json({ message: "Payment success" });

  } catch (err) {
    console.error(err);
    res.status(500).json(err);
  }
});

/////////////////////////////////////////
// 🔍 DEBUG — ลบออกหลัง deploy จริง
// เปิด https://backend-mahalarb.onrender.com/debug ดูว่า Supabase ตอบอะไร
/////////////////////////////////////////
app.get("/debug", async (req, res) => {
  const results = {};

  // Test 1: menu + categories join
  const { data: menu, error: menuErr } = await supabase
    .from("menu")
    .select("id, name, price, category_id, categories(name)")
    .limit(3);
  results.menu = menuErr ? { error: menuErr } : menu;

  // Test 2: orders table + order_date column exists
  const { data: orders, error: ordersErr } = await supabase
    .from("orders")
    .select("id, order_number, order_date, payment_status")
    .limit(3);
  results.orders = ordersErr ? { error: ordersErr } : orders;

  // Test 3: today TH date
  const TZ = 7 * 60 * 60 * 1000;
  const nowTH = new Date(Date.now() + TZ);
  results.todayTH = `${nowTH.getUTCFullYear()}-${String(nowTH.getUTCMonth()+1).padStart(2,'0')}-${String(nowTH.getUTCDate()).padStart(2,'0')}`;

  res.json(results);
});

/////////////////////////////////////////
// 🟢 DASHBOARD
/////////////////////////////////////////
app.get("/dashboard", async (req, res) => {
  const { data, error } = await supabase
    .from("orders")
    .select("total_price, created_at")
    .eq("payment_status", "success");

  if (error) return res.status(500).json(error);

  res.json(data);
});

/////////////////////////////////////////
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

/////////////////////////////////////////
// 🟢 DASHBOARD — SUMMARY (day/week/month)
// GET /dashboard/summary?period=day|week|month
/////////////////////////////////////////
app.get("/dashboard/summary", async (req, res) => {
  try {
    const period = req.query.period || "day"; // day | week | month
    const TZ = 7 * 60 * 60 * 1000;
    const nowTH = new Date(Date.now() + TZ);
    const y = nowTH.getUTCFullYear();
    const mo = nowTH.getUTCMonth();
    const d = nowTH.getUTCDate();

    let startDate, endDate, groupBy;

    if (period === "day") {
      // วันนี้ แสดงรายชั่วโมง
      startDate = `${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      endDate   = startDate;
      groupBy   = "hour";
    } else if (period === "week") {
      // 7 วันย้อนหลัง แสดงรายวัน
      const start = new Date(Date.UTC(y, mo, d) - TZ - 6 * 86400000);
      const startTH = new Date(start.getTime() + TZ);
      startDate = `${startTH.getUTCFullYear()}-${String(startTH.getUTCMonth()+1).padStart(2,'0')}-${String(startTH.getUTCDate()).padStart(2,'0')}`;
      endDate   = `${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      groupBy   = "day";
    } else {
      // เดือนนี้ แสดงรายวัน
      startDate = `${y}-${String(mo+1).padStart(2,'0')}-01`;
      endDate   = `${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      groupBy   = "day";
    }

    const { data: orders, error } = await supabase
      .from("orders")
      .select("id, order_number, total_price, order_date, created_at, payment_status, payment_method")
      .eq("payment_status", "success")
      .gte("order_date", startDate)
      .lte("order_date", endDate)
      .order("order_date", { ascending: true });

    if (error) throw error;

    // รวมยอดขาย
    const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.total_price), 0);
    const totalOrders  = orders.length;

    // แยกยอดตาม payment_method
    const cashRevenue = orders
      .filter(o => o.payment_method === "cash")
      .reduce((s, o) => s + parseFloat(o.total_price), 0);
    const qrRevenue = orders
      .filter(o => o.payment_method === "qr")
      .reduce((s, o) => s + parseFloat(o.total_price), 0);
    const cashOrders = orders.filter(o => o.payment_method === "cash").length;
    const qrOrders   = orders.filter(o => o.payment_method === "qr").length;

    // Group ตาม day หรือ hour — แยก cash/qr ด้วย
    const grouped = {};
    orders.forEach(o => {
      let key;
      if (groupBy === "hour") {
        const thTime = new Date(new Date(o.created_at).getTime() + TZ);
        key = String(thTime.getUTCHours()).padStart(2,'0') + ":00";
      } else {
        key = o.order_date;
      }
      if (!grouped[key]) grouped[key] = { label: key, revenue: 0, cash: 0, qr: 0, orders: 0 };
      grouped[key].revenue += parseFloat(o.total_price);
      grouped[key].orders  += 1;
      if (o.payment_method === "cash") grouped[key].cash += parseFloat(o.total_price);
      if (o.payment_method === "qr")   grouped[key].qr   += parseFloat(o.total_price);
    });

    res.json({
      period,
      startDate,
      endDate,
      totalRevenue,
      totalOrders,
      avgOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
      cashRevenue,
      qrRevenue,
      cashOrders,
      qrOrders,
      chart: Object.values(grouped)
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/////////////////////////////////////////
// 🟢 DASHBOARD — MENU BREAKDOWN (day/week/month)
// GET /dashboard/menu?period=day|week|month
/////////////////////////////////////////
app.get("/dashboard/menu", async (req, res) => {
  try {
    const period = req.query.period || "day";
    const TZ = 7 * 60 * 60 * 1000;
    const nowTH = new Date(Date.now() + TZ);
    const y = nowTH.getUTCFullYear();
    const mo = nowTH.getUTCMonth();
    const d = nowTH.getUTCDate();

    let startDate, endDate;

    if (period === "day") {
      startDate = `${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      endDate   = startDate;
    } else if (period === "week") {
      const start = new Date(Date.UTC(y, mo, d) - TZ - 6 * 86400000);
      const startTH = new Date(start.getTime() + TZ);
      startDate = `${startTH.getUTCFullYear()}-${String(startTH.getUTCMonth()+1).padStart(2,'0')}-${String(startTH.getUTCDate()).padStart(2,'0')}`;
      endDate   = `${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    } else {
      startDate = `${y}-${String(mo+1).padStart(2,'0')}-01`;
      endDate   = `${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }

    // หา order_id ที่ paid ในช่วงนี้ก่อน
    const { data: paidOrders, error: ordErr } = await supabase
      .from("orders")
      .select("id")
      .eq("payment_status", "success")
      .gte("order_date", startDate)
      .lte("order_date", endDate);

    if (ordErr) throw ordErr;
    if (!paidOrders || paidOrders.length === 0) return res.json({ period, startDate, endDate, items: [] });

    const orderIds = paidOrders.map(o => o.id);

    // ดึง order_items พร้อม menu name และ category
    const { data: items, error: itemErr } = await supabase
      .from("order_items")
      .select(`
        quantity,
        unit_price,
        menu:menu_id(id, name, category_id, categories(name))
      `)
      .in("order_id", orderIds);

    if (itemErr) throw itemErr;

    // Group by menu
    const menuMap = {};
    items.forEach(i => {
      const menuId = i.menu?.id;
      if (!menuId) return;
      if (!menuMap[menuId]) {
        menuMap[menuId] = {
          menu_id:       menuId,
          name:          i.menu.name,
          category:      i.menu.categories?.name || "อื่นๆ",
          qty:           0,
          revenue:       0
        };
      }
      menuMap[menuId].qty     += i.quantity;
      menuMap[menuId].revenue += i.quantity * parseFloat(i.unit_price);
    });

    // เรียงจากขายดีสุด
    const result = Object.values(menuMap).sort((a, b) => b.qty - a.qty);

    res.json({ period, startDate, endDate, items: result });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});