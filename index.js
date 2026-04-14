import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/////////////////////////////////////////
// 🔐 CONNECT SUPABASE (ใช้ ENV)
/////////////////////////////////////////

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_KEY
);

const PORT = process.env.PORT || 3000;


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
// ✏️ UPDATE MENU
//////////////////////////////////////////

app.put('/menu/:id', async (req, res) => {
  const { id } = req.params;
  const { name, price, category_name } = req.body;

  // หา category_id จากชื่อ
  const { data: category } = await supabase
    .from('categories')
    .select('id')
    .eq('name', category_name)
    .single();

  if (!category) {
    return res.status(400).json({ error: "Category not found" });
  }

  const { error } = await supabase
    .from('menu')
    .update({
      name,
      price,
      category_id: category.id
    })
    .eq('id', id);

  if (error) {
    console.log(error);
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
/////////////////////////////////////////
app.post("/order", async (req, res) => {
    const { items } = req.body;

    try {
        // ✅ 1. เอาวันนี้ (00:00 - 23:59)
        const today = new Date();
        const start = new Date(today.setHours(0, 0, 0, 0));
        const end = new Date(today.setHours(23, 59, 59, 999));

        // ✅ 2. นับ order วันนี้
        const { data: todayOrders, error: countError } = await supabase
            .from("orders")
            .select("id")
            .gte("created_at", start.toISOString())
            .lte("created_at", end.toISOString());

        if (countError) throw countError;

        const orderNumber = todayOrders.length + 1;

        // ✅ 3. คำนวณ total
        const total = items.reduce((sum, i) => sum + (i.price * i.quantity), 0);

        // ✅ 4. insert order
        const { data: order, error } = await supabase
            .from("orders")
            .insert([{
                order_number: orderNumber,
                total_price: total,
                order_status: "pending",
                payment_status: "pending"
            }])
            .select()
            .single();

        if (error) throw error;

        // ✅ 5. insert order_items
        const orderItems = items.map(i => ({
            order_id: order.id,
            menu_id: i.menu_id,
            quantity: i.quantity,
            unit_price: i.price
        }));

        await supabase.from("order_items").insert(orderItems);

        res.json({ order_id: order.id });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "สร้างออเดอร์ไม่สำเร็จ" });
    }
});



/////////////////////////////////////////
// 🟢 2. CREATE ORDER (🔥 ใช้ order_number รายวัน)
/////////////////////////////////////////
app.post("/order", async (req, res) => {
    const { items } = req.body;

    try {
        const today = new Date();
        const start = new Date(today.setHours(0, 0, 0, 0));
        const end = new Date(today.setHours(23, 59, 59, 999));

        // ✅ นับ order วันนี้
        const { data: todayOrders } = await supabase
            .from("orders")
            .select("id")
            .gte("created_at", start.toISOString())
            .lte("created_at", end.toISOString());

        const orderNumber = todayOrders.length + 1;

        // ✅ รวมราคา
        const total = items.reduce((sum, i) => sum + (i.price * i.quantity), 0);

        // ✅ insert orders
        const { data: order, error } = await supabase
            .from("orders")
            .insert([{
                order_number: orderNumber,
                total_price: total,
                order_status: "pending",
                payment_status: "pending"
            }])
            .select()
            .single();

        if (error) throw error;

        // ✅ insert order_items
        const orderItems = items.map(i => ({
            order_id: order.id,
            menu_id: i.menu_id,
            quantity: i.quantity,
            unit_price: i.price
        }));

        await supabase.from("order_items").insert(orderItems);

        res.json({ order_id: order.id });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "สร้างออเดอร์ไม่สำเร็จ" });
    }
});

/////////////////////////////////////////
// 🟢 3. GET ORDERS (🔥 เฉพาะวันนี้ + pending ขึ้นบน)
/////////////////////////////////////////
app.get("/orders", async (req, res) => {
    try {
        const today = new Date();
        const start = new Date(today.setHours(0, 0, 0, 0));
        const end = new Date(today.setHours(23, 59, 59, 999));

        const { data, error } = await supabase
            .from("order_items")
            .select(`
                order_id,
                quantity,
                unit_price,
                menu:menu_id(name),
                orders:order_id(
                    order_number,
                    payment_status,
                    created_at
                )
            `)
            .gte("orders.created_at", start.toISOString())
            .lte("orders.created_at", end.toISOString());

        if (error) throw error;

        const result = data.map(d => ({
            order_id: d.order_id,
            order_number: d.orders.order_number,
            menu_name: d.menu.name,
            quantity: d.quantity,
            unit_price: d.unit_price,
            payment_status: d.orders.payment_status,
            created_at: d.orders.created_at
        }));

        // ✅ pending ขึ้นบน
        result.sort((a, b) => {
            if (a.payment_status === b.payment_status) return b.order_id - a.order_id;
            return a.payment_status === "pending" ? -1 : 1;
        });

        res.json(result);

    } catch (err) {
        res.status(500).json({ error: "โหลดออเดอร์ไม่สำเร็จ" });
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

// app.listen(3000, () => {
//   console.log("Server running on https://backend-mahalarb.onrender.com");
// });


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});