const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Eater Backend is Live and Running! 🚀 Welcome Mahiku Cafe!');
});
// 3. नया यूजर रजिस्टर करने का API (POST Method)
app.post('/api/users', async (req, res) => {
  try {
    const { phone, name } = req.body;
    const newUser = await prisma.user.create({
      data: {
        phone: phone,
        name: name,
        role: 'CUSTOMER'
      }
    });
    res.json({ message: "User Created!", data: newUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "User registration failed" });
  }
});

// 4. Mahiku Cafe को डेटाबेस में जोड़ने का API
app.post('/api/restaurants', async (req, res) => {
  try {
    const { name, fssai } = req.body;
    const newResto = await prisma.restaurant.create({
      data: {
        name: name,
        fssaiNo: fssai,
        isActive: true
      }
    });
    res.json({ message: "Restaurant Added!", data: newResto });
  } catch (error) {
    res.status(500).json({ error: "Failed to add restaurant" });
  }
});
// 5. रेस्टोरेंट में मेन्यू आइटम जोड़ने का API
app.post('/api/menu', async (req, res) => {
  try {
    const { restaurantId, name, description, price, category, isVeg } = req.body;
    const newItem = await prisma.menuItem.create({
      data: {
        restaurantId: restaurantId,
        name: name,
        description: description,
        price: parseFloat(price),
        category: category,
        isVeg: isVeg
      }
    });
    res.json({ message: "Menu Item Added!", data: newItem });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to add menu item" });
  }
});
// 6. किसी खास रेस्टोरेंट का पूरा मेन्यू देखने का API (GET Method)
app.get('/api/menu/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const menu = await prisma.menuItem.findMany({
      where: { restaurantId: restaurantId }
    });
    res.json(menu);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch menu" });
  }
});
app.post('/api/orders', async (req, res) => {
  try {
    const { userId, restaurantId, items, totalAmount } = req.body;

    const newOrder = await prisma.order.create({
      data: {
        userId: userId,
        restaurantId: restaurantId,
        totalAmount: totalAmount,
        taxAmount: totalAmount * 0.05, // मान लीजिये 5% GST
        orderNumber: "ETR-" + Math.floor(1000 + Math.random() * 9000),
        status: 'PENDING',
        items: {
          create: items.map(item => ({
            menuItemId: item.menuItemId,
            quantity: item.quantity,
            priceAtOrder: item.price
          }))
        }
      },
      include: { items: true } // ताकि रिस्पांस में आइटम्स भी दिखें
    });

    res.json({ message: "Order Placed Successfully! 🍔", data: newOrder });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to place order" });
  }
});
// 8. सारे ऑर्डर्स की लिस्ट देखने का API (Admin के लिए)
app.get('/api/orders', async (req, res) => {
  try {
    const allOrders = await prisma.order.findMany({
      include: {
        user: true,        // ग्राहक की जानकारी भी दिखेगी
        items: {           // ऑर्डर में क्या-क्या है, वो भी दिखेगा
          include: { menuItem: true }
        }
      }
    });
    res.json(allOrders);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});
// 9. ऑर्डर का स्टेटस अपडेट करने का API (PATCH Method)
app.post('/api/orders/update-status', async (req, res) => {
  try {
    const { orderId, status } = req.body; // status में 'DELIVERED' या 'CANCELLED' भेजेंगे

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: { status: status },
    });

    res.json({ message: `Order status updated to ${status}! ✅`, data: updatedOrder });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update order status" });
  }
});
// 🚚 ऑर्डर स्टेटस अपडेट करने का रास्ता (PATCH)
app.patch('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const updatedOrder = await prisma.order.update({
      where: { id: id },
      data: { status: status },
    });
    res.json(updatedOrder);
  } catch (error) {
    res.status(500).json({ error: "Order update failed" });
  }
});
// 10. मेन्यू आइटम को डिलीट करने का API (DELETE Method)
app.delete('/api/menu/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.menuItem.delete({ where: { id: id } });
    res.json({ message: "Item removed from menu! 🗑️" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete item" });
  }
});
// ... पुराने imports और prisma init ...

// 🍔 नया आर्डर प्लेस करने का API (बिल्कुल सुरक्षित)
app.post('/api/orders', async (req, res) => {
  try {
    const { userName, userPhone, restaurantId, items, totalAmount } = req.body;

    // 1. ग्राहक को खोजें (अगर पहले आ चुका है)
    let user = await prisma.user.findFirst({ where: { phone: userPhone } });
    
    // अगर ग्राहक नया है, तो डेटाबेस में उसका नाम-नंबर सेव करें
    if (!user) {
      user = await prisma.user.create({ 
        data: { name: userName, phone: userPhone, role: 'CUSTOMER' } 
      });
    }

    // 2. आर्डर बनाएँ (सारे पुराने ज़रूरी फील्ड्स के साथ)
    const newOrder = await prisma.order.create({
      data: {
        userId: user.id,
        restaurantId: restaurantId,
        totalAmount: totalAmount,
        taxAmount: totalAmount * 0.05, // 5% GST (डेटाबेस के लिए ज़रूरी)
        orderNumber: "ETR-" + Math.floor(1000 + Math.random() * 9000), // आर्डर नंबर
        status: 'PENDING',
        items: { 
          create: items.map(i => ({ 
            menuItemId: i.menuItemId, 
            quantity: 1, 
            priceAtOrder: i.price 
          })) 
        }
      }
    });

    res.json({ message: "Order Placed!", data: newOrder });
  } catch (error) { 
    console.error("Backend Error:", error);
    res.status(500).json({ error: error.message }); 
  }
});

app.post('/api/orders/update-status', async (req, res) => {
  const { orderId, status } = req.body;
  const updated = await prisma.order.update({ where: { id: orderId }, data: { status } });
  res.json(updated);
});
// 🏪 नए रेस्टोरेंट (Vendor) को रजिस्टर करने का API
app.post('/api/restaurants', async (req, res) => {
  try {
    const { name, ownerName, phone, fssai } = req.body;

    // डेटाबेस में नया रेस्टोरेंट बनाएँ
    // (अभी हम सिर्फ नाम सेव कर रहे हैं ताकि Prisma एरर न दे)
    const newRestaurant = await prisma.restaurant.create({
      data: {
        name: name,
        location: "Kanpur/Unnao", // डिफ़ॉल्ट लोकेशन
      }
    });

    res.json({ message: "Registration Successful", data: newRestaurant });
  } catch (error) {
    console.error("Vendor Registration Error:", error);
    res.status(500).json({ error: error.message });
  }
});
// ... app.listen ...
app.listen(PORT, () => {
  console.log(`✅ Eater Server is running on http://localhost:${PORT}`);
});