import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'))

const supabase = createClient(
  "https://iknwgxxclnddoisgujzc.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlrbndneHhjbG5kZG9pc2d1anpjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTI5Njk4NiwiZXhwIjoyMDkwODcyOTg2fQ.YwgDRR_fe2CEOe8cuxh6UxV-wRCl63w3sAzS6NJXDIg",
);

/////////////////////////////////////////
// 🟢 1. GET MENU
/////////////////////////////////////////
app.get("/menu", async (req, res) => {
  const { data, error } = await supabase.from("menu").select(`
    id,
    name,
    price,
    category_id,
    categories(name)
  `);

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
    {
      name,
      price,
      category_id: category.id,
    },
  ]);

  if (error) return res.status(500).json(error);

  res.json({ message: "เพิ่มสำเร็จ" });
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
/////////////////////////////////////////
app.post("/order", async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "No items" });
    }

    let total = 0;
    items.forEach(i => total += i.quantity * i.price);

    // ✅ create order
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert([{ total_price: total, payment_status: "pending" }])
      .select()
      .single();

    if (orderError) throw orderError;

    // ✅ insert order_items
    const orderItems = items.map(i => ({
      order_id: order.id,
      menu_id: i.menu_id,
      quantity: i.quantity,
      unit_price: i.price
    }));

    const { error: itemError } = await supabase
      .from("order_items")
      .insert(orderItems);

    if (itemError) throw itemError;

    res.json({ message: "Order created", order_id: order.id });

  } catch (err) {
    console.error(err);
    res.status(500).json(err);
  }
});

/////////////////////////////////////////
// 🟢 GET ORDERS (🔥 สำคัญสุด)
/////////////////////////////////////////
app.get("/orders", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("order_items")
      .select(`
        order_id,
        quantity,
        unit_price,
        menu(name),
        orders(payment_status)
      `)
      .order("order_id", { ascending: false });

    if (error) throw error;

    // ✅ format
    let formatted = data.map(item => ({
      order_id: item.order_id,
      menu_name: item.menu?.name,
      quantity: item.quantity,
      unit_price: item.unit_price,
      payment_status: item.orders?.payment_status || "pending"
    }));

    // 🔥 SORT ตรงนี้
    formatted.sort((a, b) => {
      // pending มาก่อน
      if (a.payment_status !== b.payment_status) {
        return a.payment_status === "pending" ? -1 : 1;
      }
      // id มากก่อน (ใหม่สุด)
      return b.order_id - a.order_id;
    });

    res.json(formatted);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

/////////////////////////////////////////
// 🟢 PAYMENT (ใช้ตัวเดียวพอ)
/////////////////////////////////////////
app.post("/pay", async (req, res) => {
  try {
    const { order_id, method } = req.body;

    // ✅ update order
    const { error: updateError } = await supabase
      .from("orders")
      .update({
        payment_status: "success",
        payment_method: method
      })
      .eq("id", order_id);

    if (updateError) throw updateError;

    // ✅ insert payment log
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

app.listen(3000, () => {
  console.log("Server running on https://backend-mahalarb.onrender.com");
});