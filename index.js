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
  const todayTH = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  // UTC equivalents of Thailand midnight boundaries
  const start = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - TZ_OFFSET_MS);
  const end = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - TZ_OFFSET_MS);

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
  process.env.SUPABASE_KEY,
);

const PORT = process.env.PORT || 3000;

/////////////////////////////////////////
// 🟢 GET CATEGORIES — all categories (not just ones with menu items)
/////////////////////////////////////////
app.get("/categories", async (req, res) => {
  const { data, error } = await supabase
    .from("categories")
    .select("id, name")
    .order("id", { ascending: true });
  if (error) return res.status(500).json(error);
  res.json(data);
});

/////////////////////////////////////////
// 🟢 GET MENU — sorted by price DESC
/////////////////////////////////////////
app.get("/menu", async (req, res) => {
  const { data, error } = await supabase
    .from("menu")
    .select(`id, name, price, cost, category_id, categories(name)`)
    .order("price", { ascending: false });

  if (error) return res.status(500).json(error);

  const formatted = data.map((item) => ({
    id: item.id,
    name: item.name,
    price: parseFloat(item.price),
    cost: parseFloat(item.cost || 0),
    category_id: item.category_id,
    category_name: item.categories?.name,
  }));

  res.json(formatted);
});

/////////////////////////////////////////
// 🟢 ADD MENU
/////////////////////////////////////////
app.post("/menu", async (req, res) => {
  const { name, category_name } = req.body;
  const price = parseFloat(req.body.price);
  // FIX: ใช้ ?? แทน || เพราะ 0 เป็น falsy ทำให้ cost ที่กรอก 0 กลายเป็น 0 ถูก แต่ถ้าไม่กรอกก็ควรเป็น 0
  const rawCost = req.body.cost;
  const cost =
    rawCost === undefined || rawCost === null || rawCost === ""
      ? 0
      : parseFloat(rawCost);

  if (!name || isNaN(price) || !category_name) {
    return res.status(400).json({ error: "ข้อมูลไม่ครบ" });
  }

  const { data: category } = await supabase
    .from("categories")
    .select("id")
    .eq("name", category_name)
    .single();

  if (!category) return res.status(400).json({ error: "Category not found" });

  const { data: inserted, error } = await supabase
    .from("menu")
    .insert([{ name, price, cost, category_id: category.id }])
    .select(); // FIX: ดึงกลับมาเพื่อยืนยันว่า insert สำเร็จจริง

  if (error) {
    console.error("POST /menu error:", error);
    return res.status(500).json({ error: error.message });
  }

  if (!inserted || inserted.length === 0) {
    console.error("POST /menu: insert returned empty — possible RLS block");
    return res.status(500).json({ error: "บันทึกไม่สำเร็จ อาจถูก RLS block" });
  }

  res.json({ message: "เพิ่มสำเร็จ", data: inserted[0] });
});

/////////////////////////////////////////
// ✏️ UPDATE MENU
/////////////////////////////////////////
app.put("/menu/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, category_name } = req.body;
  const price = parseFloat(req.body.price);
  const rawCost = req.body.cost;
  const cost =
    rawCost === undefined || rawCost === null || rawCost === ""
      ? 0
      : parseFloat(rawCost);

  // 🔍 DEBUG — ดูใน Render logs แล้วลบออกหลังแก้เสร็จ
  console.log("[PUT /menu] body:", JSON.stringify(req.body));
  console.log(
    "[PUT /menu] parsed → id:",
    id,
    "cost:",
    cost,
    "rawCost:",
    rawCost,
  );

  if (!name || isNaN(price) || !category_name) {
    return res.status(400).json({ error: "Missing or invalid fields" });
  }

  // หา category_id จากชื่อ
  const { data: category, error: catErr } = await supabase
    .from("categories")
    .select("id")
    .eq("name", category_name)
    .single();

  if (catErr || !category) {
    return res.status(400).json({ error: "Category not found" });
  }

  const { data: updated, error } = await supabase
    .from("menu")
    .update({ name, price, cost, category_id: category.id })
    .eq("id", id)
    .select();

  // 🔍 DEBUG — ดูใน Render logs
  console.log(
    "[PUT /menu] supabase update result → error:",
    error,
    "updated:",
    JSON.stringify(updated),
  );

  if (error) {
    console.error("PUT /menu/:id error:", error);
    return res.status(500).json({ error: error.message });
  }

  // FIX: ถ้า updated เป็น array ว่าง = RLS block หรือ id ไม่มีใน DB
  if (!updated || updated.length === 0) {
    console.error(
      "PUT /menu/:id: no rows updated — RLS block or id not found, id =",
      id,
    );
    return res
      .status(404)
      .json({ error: `ไม่พบเมนู id=${id} หรือไม่มีสิทธิ์แก้ไข (RLS)` });
  }

  res.json({ message: "updated", data: updated[0] });
});

/////////////////////////////////////////
// 🟢 DELETE MENU
/////////////////////////////////////////
app.delete("/menu/:id", async (req, res) => {
  const id = parseInt(req.params.id); // FIX: parse to int

  // FIX: ตรวจก่อนว่ามี order_items อ้างอิง menu นี้อยู่ไหม
  // ถ้ามีให้ reject ทันที แทนที่จะให้ DB ขึ้น FK error
  const { count } = await supabase
    .from("order_items")
    .select("id", { count: "exact", head: true })
    .eq("menu_id", id);

  if (count > 0) {
    return res.status(409).json({
      error: "ไม่สามารถลบได้ เมนูนี้มีออเดอร์ที่ใช้งานอยู่",
    });
  }

  const { error } = await supabase.from("menu").delete().eq("id", id);

  // FIX: เช็ค error และส่ง status ที่ถูกต้อง
  if (error) {
    console.error("DELETE /menu/:id error:", error);
    return res.status(500).json({ error: error.message });
  }

  res.json({ message: "deleted" });
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
        p_items: items.map((i) => ({
          menu_id: i.menu_id,
          quantity: i.quantity,
          unit_price: i.price,
        })),
      },
    );

    if (orderError) throw orderError;

    // Supabase RPC returning jsonb comes back as a string — parse it
    const result = typeof order === "string" ? JSON.parse(order) : order;
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

    const orderIds = todayOrders.map((o) => o.id);

    // Step 2: Get order_items for those orders
    const { data: items, error: itemsError } = await supabase
      .from("order_items")
      .select(
        `
        order_id,
        quantity,
        unit_price,
        menu:menu_id(name)
      `,
      )
      .in("order_id", orderIds);

    if (itemsError) throw itemsError;

    // Step 3: Build a lookup map for orders
    const orderMap = {};
    todayOrders.forEach((o) => {
      orderMap[o.id] = o;
    });

    // Step 4: Flatten into the shape the frontend's groupOrders() expects
    const result = items.map((item) => ({
      order_id: item.order_id,
      order_number: orderMap[item.order_id]?.order_number,
      menu_name: item.menu?.name,
      quantity: item.quantity,
      unit_price: item.unit_price,
      payment_status: orderMap[item.order_id]?.payment_status,
      created_at: orderMap[item.order_id]?.created_at,
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
        order_status: "paid",
      })
      .eq("id", order_id);

    if (updateError) throw updateError;

    const { error: payError } = await supabase.from("payments").insert([
      {
        order_id,
        method,
        status: "success",
        paid_at: new Date(),
      },
    ]);

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
  results.todayTH = `${nowTH.getUTCFullYear()}-${String(nowTH.getUTCMonth() + 1).padStart(2, "0")}-${String(nowTH.getUTCDate()).padStart(2, "0")}`;

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
// 🔧 HELPER — parse period + optional month param
// period: day | week | month | history
// month: YYYY-MM (used when period=month to pick specific month)
/////////////////////////////////////////
function parsePeriod(query) {
  const TZ = 7 * 60 * 60 * 1000;
  const nowTH = new Date(Date.now() + TZ);
  const ty = nowTH.getUTCFullYear();
  const tm = nowTH.getUTCMonth(); // 0-based
  const td = nowTH.getUTCDate();
  const todayStr = `${ty}-${String(tm + 1).padStart(2, "0")}-${String(td).padStart(2, "0")}`;

  const period = query.period || "day";
  let startDate,
    endDate,
    groupBy = "day";

  if (period === "day") {
    startDate = endDate = todayStr;
    groupBy = "hour";
  } else if (period === "week") {
    const s = new Date(Date.UTC(ty, tm, td) - TZ - 6 * 86400000);
    const sTH = new Date(s.getTime() + TZ);
    startDate = `${sTH.getUTCFullYear()}-${String(sTH.getUTCMonth() + 1).padStart(2, "0")}-${String(sTH.getUTCDate()).padStart(2, "0")}`;
    endDate = todayStr;
    groupBy = "day";
  } else if (period === "month") {
    // FIX: รับ ?month=YYYY-MM เพื่อ query เดือนที่ต้องการ
    // ถ้าไม่ส่งมา = เดือนนี้
    let y = ty,
      mo = tm + 1; // mo = 1-based
    if (query.month && /^\d{4}-\d{2}$/.test(query.month)) {
      [y, mo] = query.month.split("-").map(Number);
    }
    const lastDay = new Date(y, mo, 0).getDate(); // วันสุดท้ายของเดือน
    startDate = `${y}-${String(mo).padStart(2, "0")}-01`;
    // ถ้าเป็นเดือนปัจจุบัน ให้ endDate = วันนี้, ถ้าเดือนที่ผ่านมา = วันสุดท้าย
    const isCurrentMonth = y === ty && mo === tm + 1;
    endDate = isCurrentMonth
      ? todayStr
      : `${y}-${String(mo).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    groupBy = "day";
  } else if (period === "history") {
    // สรุปรายเดือน 12 เดือนย้อนหลัง
    const s = new Date(ty, tm - 11, 1); // 12 months back
    startDate = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-01`;
    endDate = todayStr;
    groupBy = "month";
  }

  return { period, startDate, endDate, groupBy };
}

/////////////////////////////////////////
// 🟢 DASHBOARD — SUMMARY
// GET /dashboard/summary?period=day|week|month|history&month=YYYY-MM
/////////////////////////////////////////
app.get("/dashboard/summary", async (req, res) => {
  try {
    const { period, startDate, endDate, groupBy } = parsePeriod(req.query);

    const { data: orders, error } = await supabase
      .from("orders")
      .select(
        "id, order_number, total_price, order_date, created_at, payment_status, payment_method",
      )
      .eq("payment_status", "success")
      .gte("order_date", startDate)
      .lte("order_date", endDate)
      .order("order_date", { ascending: true });

    if (error) throw error;

    // รวมยอดขาย
    const totalRevenue = orders.reduce(
      (s, o) => s + parseFloat(o.total_price),
      0,
    );
    const totalOrders = orders.length;

    // แยกยอดตาม payment_method
    const cashRevenue = orders
      .filter((o) => o.payment_method === "cash")
      .reduce((s, o) => s + parseFloat(o.total_price), 0);
    const qrRevenue = orders
      .filter((o) => o.payment_method === "qr")
      .reduce((s, o) => s + parseFloat(o.total_price), 0);
    const cashOrders = orders.filter((o) => o.payment_method === "cash").length;
    const qrOrders = orders.filter((o) => o.payment_method === "qr").length;

    // Group ตาม hour / day / month
    const TZ = 7 * 60 * 60 * 1000;
    const grouped = {};
    orders.forEach((o) => {
      let key;
      if (groupBy === "hour") {
        const thTime = new Date(new Date(o.created_at).getTime() + TZ);
        key = String(thTime.getUTCHours()).padStart(2, "0") + ":00";
      } else if (groupBy === "month") {
        key = o.order_date.slice(0, 7); // YYYY-MM
      } else {
        key = o.order_date;
      }
      if (!grouped[key])
        grouped[key] = { label: key, revenue: 0, cash: 0, qr: 0, orders: 0 };
      grouped[key].revenue += parseFloat(o.total_price);
      grouped[key].orders += 1;
      if (o.payment_method === "cash")
        grouped[key].cash += parseFloat(o.total_price);
      if (o.payment_method === "qr")
        grouped[key].qr += parseFloat(o.total_price);
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
      chart: Object.values(grouped),
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
    const { period, startDate, endDate } = parsePeriod(req.query);

    // หา order_id ที่ paid ในช่วงนี้ก่อน
    const { data: paidOrders, error: ordErr } = await supabase
      .from("orders")
      .select("id")
      .eq("payment_status", "success")
      .gte("order_date", startDate)
      .lte("order_date", endDate);

    if (ordErr) throw ordErr;
    if (!paidOrders || paidOrders.length === 0)
      return res.json({ period, startDate, endDate, items: [] });

    const orderIds = paidOrders.map((o) => o.id);

    // ดึง order_items พร้อม menu name และ category
    const { data: items, error: itemErr } = await supabase
      .from("order_items")
      .select(
        `
        quantity,
        unit_price,
        menu:menu_id(id, name, category_id, categories(name))
      `,
      )
      .in("order_id", orderIds);

    if (itemErr) throw itemErr;

    // Group by menu
    const menuMap = {};
    items.forEach((i) => {
      const menuId = i.menu?.id;
      if (!menuId) return;
      if (!menuMap[menuId]) {
        menuMap[menuId] = {
          menu_id: menuId,
          name: i.menu.name,
          category: i.menu.categories?.name || "อื่นๆ",
          qty: 0,
          revenue: 0,
        };
      }
      menuMap[menuId].qty += i.quantity;
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

/////////////////////////////////////////
// 🟢 EXPENSES — LIST
// GET /expenses?period=day|week|month
/////////////////////////////////////////
app.get("/expenses", async (req, res) => {
  try {
    const period = req.query.period || "day";
    const { todayTH } = getTodayRangeUTC();
    const [y, m] = todayTH.split("-").map(Number);

    let startDate, endDate;
    if (period === "day") {
      startDate = endDate = todayTH;
    } else if (period === "week") {
      const d = new Date(todayTH);
      d.setDate(d.getDate() - 6);
      startDate = d.toISOString().slice(0, 10);
      endDate = todayTH;
    } else {
      startDate = `${y}-${String(m).padStart(2, "0")}-01`;
      endDate = todayTH;
    }

    const { data, error } = await supabase
      .from("expenses")
      .select("id, title, amount, category, expense_date, created_at")
      .gte("expense_date", startDate)
      .lte("expense_date", endDate)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) throw error;

    // Group by category for summary
    const byCategory = {};
    data.forEach((e) => {
      const cat = e.category || "ทั่วไป";
      if (!byCategory[cat]) byCategory[cat] = 0;
      byCategory[cat] += parseFloat(e.amount);
    });

    const totalExpense = data.reduce((s, e) => s + parseFloat(e.amount), 0);

    res.json({
      period,
      startDate,
      endDate,
      totalExpense,
      byCategory,
      items: data,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/////////////////////////////////////////
// 🟢 EXPENSES — CREATE
// POST /expense  { title, amount, category, expense_date }
/////////////////////////////////////////
app.post("/expense", async (req, res) => {
  try {
    const { title, amount, category, expense_date } = req.body;

    if (
      !title ||
      !amount ||
      isNaN(parseFloat(amount)) ||
      parseFloat(amount) <= 0
    ) {
      return res.status(400).json({ error: "ข้อมูลไม่ถูกต้อง" });
    }

    const { todayTH } = getTodayRangeUTC();

    const { error } = await supabase.from("expenses").insert([
      {
        title,
        amount: parseFloat(amount),
        category: category || "ทั่วไป",
        expense_date: expense_date || todayTH,
      },
    ]);

    if (error) throw error;
    res.json({ message: "บันทึกสำเร็จ" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/////////////////////////////////////////
// 🟢 EXPENSES — DELETE
// DELETE /expense/:id
/////////////////////////////////////////
app.delete("/expense/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { error } = await supabase.from("expenses").delete().eq("id", id);
    if (error) throw error;
    res.json({ message: "ลบสำเร็จ" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/////////////////////////////////////////
// 🟢 PROFIT/LOSS SUMMARY
// GET /dashboard/profit?period=day|week|month
// Returns: revenue, expense, profit per day/period
/////////////////////////////////////////
app.get("/dashboard/profit", async (req, res) => {
  try {
    const { period, startDate, endDate, groupBy } = parsePeriod(req.query);

    // Revenue (paid orders)
    const { data: orders, error: ordErr } = await supabase
      .from("orders")
      .select("order_date, total_price, payment_method")
      .eq("payment_status", "success")
      .gte("order_date", startDate)
      .lte("order_date", endDate);
    if (ordErr) throw ordErr;

    // Expenses
    const { data: expenses, error: expErr } = await supabase
      .from("expenses")
      .select("expense_date, amount, category")
      .gte("expense_date", startDate)
      .lte("expense_date", endDate);
    if (expErr) throw expErr;

    // Build map — group by day or month depending on period
    const dayMap = {};
    if (groupBy === "month") {
      // fill all months in range
      const cursor = new Date(startDate.slice(0, 7) + "-01");
      const last = new Date(endDate.slice(0, 7) + "-01");
      while (cursor <= last) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
        dayMap[key] = { date: key, revenue: 0, expense: 0, profit: 0 };
        cursor.setMonth(cursor.getMonth() + 1);
      }
      orders.forEach((o) => {
        const key = o.order_date.slice(0, 7);
        if (dayMap[key]) dayMap[key].revenue += parseFloat(o.total_price);
      });
      expenses.forEach((e) => {
        const key = e.expense_date.slice(0, 7);
        if (dayMap[key]) dayMap[key].expense += parseFloat(e.amount);
      });
    } else {
      // fill all days in range
      const cursor = new Date(startDate);
      const last = new Date(endDate);
      while (cursor <= last) {
        const key = cursor.toISOString().slice(0, 10);
        dayMap[key] = { date: key, revenue: 0, expense: 0, profit: 0 };
        cursor.setDate(cursor.getDate() + 1);
      }
      orders.forEach((o) => {
        const k = o.order_date;
        if (dayMap[k]) dayMap[k].revenue += parseFloat(o.total_price);
      });
      expenses.forEach((e) => {
        const k = e.expense_date;
        if (dayMap[k]) dayMap[k].expense += parseFloat(e.amount);
      });
    }
    Object.values(dayMap).forEach((d) => {
      d.profit = d.revenue - d.expense;
    });

    const totalRevenue = orders.reduce(
      (s, o) => s + parseFloat(o.total_price),
      0,
    );
    const totalExpense = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const totalProfit = totalRevenue - totalExpense;

    // Expense breakdown by category
    const byCategory = {};
    expenses.forEach((e) => {
      const cat = e.category || "ทั่วไป";
      if (!byCategory[cat]) byCategory[cat] = 0;
      byCategory[cat] += parseFloat(e.amount);
    });

    res.json({
      period,
      startDate,
      endDate,
      totalRevenue,
      totalExpense,
      totalProfit,
      byCategory,
      chart: Object.values(dayMap),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/////////////////////////////////////////
// 🟢 COST ANALYSIS
// GET /dashboard/cost-analysis?period=day|week|month
// ใช้ menu.cost (ต้นทุนรวม) + menu_costs (ingredient ละเอียด)
/////////////////////////////////////////
app.get("/dashboard/cost-analysis", async (req, res) => {
  try {
    const period = req.query.period || "month";
    const { todayTH } = getTodayRangeUTC();
    const [y, m] = todayTH.split("-").map(Number);

    let startDate, endDate;
    if (period === "day") {
      startDate = endDate = todayTH;
    } else if (period === "week") {
      const d = new Date(todayTH);
      d.setDate(d.getDate() - 6);
      startDate = d.toISOString().slice(0, 10);
      endDate = todayTH;
    } else {
      startDate = `${y}-${String(m).padStart(2, "0")}-01`;
      endDate = todayTH;
    }

    // ── 1. เมนู + cost summary (menu.cost) ──────────────────────
    const { data: menus, error: menuErr } = await supabase
      .from("menu")
      .select("id, name, price, cost, category_id, categories(name)")
      .order("price", { ascending: true });
    if (menuErr) throw menuErr;

    // ── 2. ingredient ละเอียดจาก menu_costs ─────────────────────
    const { data: menuCosts } = await supabase
      .from("menu_costs")
      .select("menu_id, item, amount, unit, cost");

    // build map: menu_id → ingredients[]
    const ingredientMap = {};
    (menuCosts || []).forEach((mc) => {
      if (!ingredientMap[mc.menu_id]) ingredientMap[mc.menu_id] = [];
      ingredientMap[mc.menu_id].push({
        item: mc.item,
        amount: parseFloat(mc.amount || 0),
        unit: mc.unit,
        cost: parseFloat(mc.cost || 0),
      });
    });

    // ── 3. ยอดขายในช่วงเวลา (paid orders) ──────────────────────
    const { data: paidOrders } = await supabase
      .from("orders")
      .select("id")
      .eq("payment_status", "success")
      .gte("order_date", startDate)
      .lte("order_date", endDate);

    const orderIds = (paidOrders || []).map((o) => o.id);
    const soldMap = {}; // menu_id → { qty, revenue }

    if (orderIds.length > 0) {
      const { data: items } = await supabase
        .from("order_items")
        .select("menu_id, quantity, unit_price")
        .in("order_id", orderIds);

      (items || []).forEach((i) => {
        if (!soldMap[i.menu_id]) soldMap[i.menu_id] = { qty: 0, revenue: 0 };
        soldMap[i.menu_id].qty += i.quantity;
        soldMap[i.menu_id].revenue += i.quantity * parseFloat(i.unit_price);
      });
    }

    // ── 4. คำนวณ per-menu metrics ────────────────────────────────
    const menuAnalysis = menus.map((menu) => {
      const price = parseFloat(menu.price);

      // ถ้ามี ingredient ละเอียด ให้รวมจาก menu_costs.cost ก่อน
      // ถ้าไม่มีให้ fallback ไปใช้ menu.cost
      const ingredients = ingredientMap[menu.id] || [];
      const costFromIngredients = ingredients.reduce(
        (s, ing) => s + ing.cost,
        0,
      );
      const cost =
        costFromIngredients > 0
          ? costFromIngredients
          : parseFloat(menu.cost || 0);

      const margin = price - cost;
      const marginPct = price > 0 ? (margin / price) * 100 : 0;
      const sold = soldMap[menu.id] || { qty: 0, revenue: 0 };
      const totalCost = cost * sold.qty;
      const profit = sold.revenue - totalCost;

      // ── คำแนะนำอัตโนมัติ ──
      let advice, adviceType;
      if (cost === 0) {
        advice = "ยังไม่มีต้นทุน กรุณากรอกใน menu_costs";
        adviceType = "warn";
      } else if (marginPct < 20) {
        advice = "🔴 Margin ต่ำมาก — ควรขึ้นราคาหรือลดต้นทุน";
        adviceType = "danger";
      } else if (marginPct < 40) {
        advice = "🟡 Margin ปานกลาง — พิจารณาลดต้นทุนวัตถุดิบ";
        adviceType = "warn";
      } else if (sold.qty >= 10 && marginPct >= 60) {
        advice = "⭐ ขายดี + Margin สูง — Push การขายเพิ่ม";
        adviceType = "star";
      } else if (sold.qty === 0) {
        advice = "ไม่มียอดขายในช่วงนี้";
        adviceType = "info";
      } else {
        advice = "✅ Margin ดี";
        adviceType = "ok";
      }

      // ingredient ที่แพงที่สุด (ควรพิจารณาลด)
      const topIngredient =
        ingredients.length > 0
          ? ingredients.sort((a, b) => b.cost - a.cost)[0]
          : null;

      return {
        id: menu.id,
        name: menu.name,
        category: menu.categories?.name || "อื่นๆ",
        price,
        cost,
        margin,
        marginPct: Math.round(marginPct * 10) / 10,
        qty: sold.qty,
        revenue: Math.round(sold.revenue * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        advice,
        adviceType,
        ingredients, // ingredient list สำหรับ expand ในหน้าเว็บ
        topIngredient, // ingredient ที่ cost สูงสุด
        hasCostDetail: ingredients.length > 0,
      };
    });

    // ── 5. รายจ่ายจาก expenses table ────────────────────────────
    const { data: rawExpenses } = await supabase
      .from("expenses")
      .select("amount, category")
      .gte("expense_date", startDate)
      .lte("expense_date", endDate);

    const totalExpense = (rawExpenses || []).reduce(
      (s, e) => s + parseFloat(e.amount),
      0,
    );
    const ingredientExpense = (rawExpenses || [])
      .filter((e) => e.category === "วัตถุดิบ")
      .reduce((s, e) => s + parseFloat(e.amount), 0);
    const totalRevenue = Object.values(soldMap).reduce(
      (s, v) => s + v.revenue,
      0,
    );
    const foodCostPct =
      totalRevenue > 0 ? (ingredientExpense / totalRevenue) * 100 : 0;

    // ── 6. สรุปต้นทุนที่ใช้จริงต่อ ingredient ──────────────────
    // ถ้ามีข้อมูล qty ที่ขาย → คำนวณ ingredient ที่ใช้ไปทั้งหมด
    const ingredientUsage = {};
    menus.forEach((menu) => {
      const sold = soldMap[menu.id];
      if (!sold || sold.qty === 0) return;
      (ingredientMap[menu.id] || []).forEach((ing) => {
        if (!ingredientUsage[ing.item])
          ingredientUsage[ing.item] = {
            item: ing.item,
            unit: ing.unit,
            totalUsed: 0,
            totalCost: 0,
          };
        ingredientUsage[ing.item].totalUsed += ing.amount * sold.qty;
        ingredientUsage[ing.item].totalCost += ing.cost * sold.qty;
      });
    });
    const ingredientUsageSorted = Object.values(ingredientUsage).sort(
      (a, b) => b.totalCost - a.totalCost,
    );

    // expense by category
    const expByCategory = {};
    (rawExpenses || []).forEach((e) => {
      const cat = e.category || "ทั่วไป";
      if (!expByCategory[cat]) expByCategory[cat] = 0;
      expByCategory[cat] += parseFloat(e.amount);
    });
    const expSorted = Object.entries(expByCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => ({ cat, amt }));

    res.json({
      period,
      startDate,
      endDate,
      totalRevenue,
      totalExpense,
      ingredientExpense,
      foodCostPct: Math.round(foodCostPct * 10) / 10,
      expByCategory: expSorted,
      ingredientUsage: ingredientUsageSorted, // วัตถุดิบที่ใช้ไปจริงในช่วงนี้
      menuAnalysis: menuAnalysis.sort((a, b) => b.marginPct - a.marginPct),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/////////////////////////////////////////
// 🟢 MENU COSTS — GET ingredients by menu
// GET /menu-costs/:menu_id
/////////////////////////////////////////
app.get("/menu-costs/:menu_id", async (req, res) => {
  try {
    const menu_id = parseInt(req.params.menu_id);
    const { data: ingredients, error } = await supabase
      .from("menu_costs")
      .select("id, menu_id, item, amount, unit, cost")
      .eq("menu_id", menu_id)
      .order("id", { ascending: true });
    if (error) throw error;

    const totalCost = ingredients.reduce(
      (s, i) => s + parseFloat(i.cost || 0),
      0,
    );

    const { data: menu } = await supabase
      .from("menu")
      .select("id, name, price, cost, categories(name)")
      .eq("id", menu_id)
      .single();

    res.json({
      menu,
      ingredients,
      totalCost: Math.round(totalCost * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/////////////////////////////////////////
// 🟢 MENU COSTS — ADD ingredient
// POST /menu-costs { menu_id, item, amount, unit, cost }
/////////////////////////////////////////
app.post("/menu-costs", async (req, res) => {
  try {
    const { menu_id, item, unit } = req.body;
    const amount = parseFloat(req.body.amount || 0);
    const cost = parseFloat(req.body.cost || 0);
    if (!menu_id || !item)
      return res.status(400).json({ error: "ข้อมูลไม่ครบ" });

    const { error } = await supabase
      .from("menu_costs")
      .insert([
        { menu_id: parseInt(menu_id), item, amount, unit: unit || "", cost },
      ]);
    if (error) throw error;

    await syncMenuCost(parseInt(menu_id));
    res.json({ message: "เพิ่มสำเร็จ" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/////////////////////////////////////////
// 🟢 MENU COSTS — UPDATE ingredient
// PUT /menu-costs/:id { item, amount, unit, cost }
/////////////////////////////////////////
app.put("/menu-costs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { item, unit } = req.body;
    const amount = parseFloat(req.body.amount || 0);
    const cost = parseFloat(req.body.cost || 0);
    if (!item) return res.status(400).json({ error: "ข้อมูลไม่ครบ" });

    const { data: existing } = await supabase
      .from("menu_costs")
      .select("menu_id")
      .eq("id", id)
      .single();

    const { error } = await supabase
      .from("menu_costs")
      .update({ item, amount, unit: unit || "", cost })
      .eq("id", id);
    if (error) throw error;

    if (existing?.menu_id) await syncMenuCost(existing.menu_id);
    res.json({ message: "แก้ไขสำเร็จ" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/////////////////////////////////////////
// 🟢 MENU COSTS — DELETE ingredient
// DELETE /menu-costs/:id
/////////////////////////////////////////
app.delete("/menu-costs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { data: existing } = await supabase
      .from("menu_costs")
      .select("menu_id")
      .eq("id", id)
      .single();

    const { error } = await supabase.from("menu_costs").delete().eq("id", id);
    if (error) throw error;

    if (existing?.menu_id) await syncMenuCost(existing.menu_id);
    res.json({ message: "ลบสำเร็จ" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/////////////////////////////////////////
// 🔧 HELPER — sync menu.cost = sum(menu_costs.cost)
/////////////////////////////////////////
async function syncMenuCost(menu_id) {
  const { data } = await supabase
    .from("menu_costs")
    .select("cost")
    .eq("menu_id", menu_id);
  const total = (data || []).reduce((s, r) => s + parseFloat(r.cost || 0), 0);
  await supabase
    .from("menu")
    .update({ cost: Math.round(total * 100) / 100 })
    .eq("id", menu_id);
}
