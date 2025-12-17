const { Bot, Keyboard, InlineKeyboard, session } = require("grammy");
const mongoose = require("mongoose");
const http = require("http");
const dayjs = require("dayjs");
const axios = require("axios");
const cheerio = require("cheerio");

// --- ⚙️ НАСТРОЙКИ ---
const token = "7973955726:AAFpMltfoqwO902Q1su5j6HWipPxEJYM3-o";
const webAppUrl = "https://hotmaptaxi-git-main-dorians-projects-14978635.vercel.app";
const mongoUri = "mongodb+srv://user775586:user775586@cluster0.36spuej.mongodb.net/?appName=Cluster0"; 
const ADMIN_ID = 623203896; 

const bot = new Bot(token);

// --- 🗄️ БАЗА ДАННЫХ ---
mongoose.connect(mongoUri);

const User = mongoose.model("User", new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: String, tariff: String, city: String,
    isAllowed: { type: Boolean, default: false },
    username: String
}));

const Fuel = mongoose.model("Fuel", new mongoose.Schema({
    city: { type: String, unique: true },
    ai92: String, ai95: String, dt: String, gas: String, lastUpdate: Date
}));

const Order = mongoose.model("Order", new mongoose.Schema({
    userId: Number, username: String, carNumber: String, phone: String,
    status: { type: String, default: "Новая" }, date: { type: Date, default: Date.now }
}));

// Новая схема для мероприятий
const Event = mongoose.model("Event", new mongoose.Schema({
    city: String, title: String, dateTxt: String, address: String, link: String,
    expireAt: { type: Date, default: () => dayjs().add(1, 'day').toDate() }
}));

bot.use(session({ initial: () => ({ step: "idle", tariff: null, carNumber: null }) }));

// --- 🌐 ПАРСЕР МЕРОПРИЯТИЙ (KudaGo) ---
async function updateEvents(city) {
    const slugs = { "Москва": "msk", "Санкт-Петербург": "spb", "Казань": "kzn" };
    const slug = slugs[city] || "msk";
    try {
        const { data } = await axios.get(`https://kudago.com/${slug}/events/`, { timeout: 8000 });
        const $ = cheerio.load(data);
        const found = [];
        
        $(".post-title a").each((i, el) => {
            if (i < 8) { // Берем топ-8 событий
                found.push({
                    city,
                    title: $(el).text().trim(),
                    link: $(el).attr("href"),
                    // Парсинг даты и адреса обычно требует захода внутрь статьи, 
                    // для примера возьмем заглушку или описание
                });
            }
        });

        if (found.length > 0) {
            await Event.deleteMany({ city }); // Очищаем старые
            await Event.insertMany(found);
            return true;
        }
    } catch (e) { console.log("Ошибка парсера событий:", e.message); return false; }
}

// --- 🌐 ПАРСЕР ЦЕН НА ТОПЛИВО ---
async function fetchFuelPrices(cityName) {
    try {
        const cityTranslit = { "Москва": "moskva", "Санкт-Петербург": "sankt-peterburg", "Казань": "kazan" };
        const slug = cityTranslit[cityName] || "moskva";
        const { data } = await axios.get(`https://fuelprices.ru/${slug}`, { 
            timeout: 7000, headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $ = cheerio.load(data);
        const p = [];
        $(".price_table tr td").each((i, el) => p.push($(el).text().trim()));
        if (p.length > 5) {
            const res = { city: cityName, ai92: p[1], ai95: p[3], dt: p[5], gas: p[7], lastUpdate: new Date() };
            await Fuel.findOneAndUpdate({ city: cityName }, res, { upsert: true });
            return res;
        }
        return null;
    } catch (e) { return null; }
}

// --- 🚀 ОБРАБОТКА ---

bot.command("start", async (ctx) => {
    let user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        ctx.session.step = "wait_tariff";
        const kb = new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime();
        await ctx.reply("🚕 Добро пожаловать! Выберите тариф:", { reply_markup: kb });
    } else {
        const menu = new Keyboard()
            .text("Открыть карту 🔥").row()
            .text("События города 🎭").text("Цены на топливо ⛽️").row()
            .text("Аналитика 📊").text("Мой профиль 👤").resized();
        
        if (ctx.from.id === ADMIN_ID) {
            menu.row().text("Список водителей 📋").text("Заявки на аналитику 📂").row().text("Обновить базу событий 🔄");
        }
        await ctx.reply("🏠 Главное меню", { reply_markup: menu });
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;

    if (text === "События города 🎭") {
        const u = await User.findOne({ userId });
        const events = await Event.find({ city: u?.city || "Москва" }).limit(5);
        if (events.length === 0) return ctx.reply("📅 На сегодня событий пока не найдено. Попробуйте позже.");
        
        let msg = `🎭 **Мероприятия в г. ${u?.city || "Москва"}:**\n\n`;
        events.forEach((e, i) => {
            msg += `${i+1}. [${e.title}](${e.link})\n`;
        });
        return ctx.reply(msg, { parse_mode: "Markdown", disable_web_page_preview: true });
    }

    if (text === "Обновить базу событий 🔄" && userId === ADMIN_ID) {
        await ctx.reply("⏳ Запускаю парсер KudaGo...");
        await updateEvents("Москва");
        await updateEvents("Санкт-Петербург");
        await updateEvents("Казань");
        return ctx.reply("✅ База событий обновлена!");
    }

    if (text === "Аналитика 📊") {
        const txt = "Мы предлагаем комплексную аналитику вашего аккаунта ЯндексGo на предмет теневых ограничений (теневого бана)... \n\n💰 **Стоимость аналитики составляет 2490 ₽**";
        const kb = new InlineKeyboard().text("✅ Согласен", "analyt_start").text("❌ Отмена", "analyt_cancel");
        return ctx.reply(txt, { reply_markup: kb, parse_mode: "Markdown" });
    }

    if (ctx.session.step === "analyt_wait_car") {
        ctx.session.carNumber = text;
        ctx.session.step = "analyt_wait_phone";
        return ctx.reply("📱 Теперь введите ваш номер телефона для связи:");
    }

    if (ctx.session.step === "analyt_wait_phone") {
        const order = new Order({ userId, username: ctx.from.username || "нет", carNumber: ctx.session.carNumber, phone: text });
        await order.save();
        ctx.session.step = "idle";
        await ctx.reply("✅ Ваша заявка принята! Админ свяжется с вами.");
        return bot.api.sendMessage(ADMIN_ID, `🔥 **Заявка на АНАЛИТИКУ!**\nОт: @${ctx.from.username}\nНомер: ${ctx.session.carNumber}\nТел: ${text}`);
    }

    if (text === "Цены на топливо ⛽️") {
        const u = await User.findOne({ userId });
        const f = await fetchFuelPrices(u?.city || "Москва");
        if (!f) return ctx.reply("❌ Не удалось получить свежие цены.");
        return ctx.reply(`⛽️ **Цены в г. ${u.city}:**\n\n🔹 АИ-92: ${f.ai92} р.\n🔸 АИ-95: ${f.ai95} р.\n🚜 ДТ: ${f.dt} р.\n💨 Газ: ${f.gas} р.`, { parse_mode: "Markdown" });
    }

    if (text === "Заявки на аналитику 📂" && userId === ADMIN_ID) {
        const orders = await Order.find({ status: "Новая" });
        if (orders.length === 0) return ctx.reply("Заявок нет.");
        for (const o of orders) {
            const kb = new InlineKeyboard().text("✅ Обработано", `doneorder_${o._id}`);
            await ctx.reply(`📝 Заявка от @${o.username}\n🚗 Авто: ${o.carNumber}\n📞 Тел: ${o.phone}`, { reply_markup: kb });
        }
        return;
    }

    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        const kb = new InlineKeyboard();
        ["Москва", "Санкт-Петербург", "Казань"].forEach(c => kb.text(c, `regcity_${c}`).row());
        await ctx.reply("🏙 Выберите город:", { reply_markup: kb });
    }

    if (text === "Открыть карту 🔥") {
        const u = await User.findOne({ userId });
        if (u?.isAllowed) return ctx.reply("📍 Карта:", { reply_markup: new InlineKeyboard().webApp("Открыть", webAppUrl) });
        return ctx.reply("🚫 Нет доступа.");
    }

    if (text === "Список водителей 📋" && userId === ADMIN_ID) {
        const users = await User.find();
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row());
        return ctx.reply("Список водителей:", { reply_markup: kb });
    }
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data === "analyt_start") {
        ctx.session.step = "analyt_wait_car";
        await ctx.editMessageText("🔢 Введите госномер вашей машины:");
    }

    if (data.startsWith("regcity_")) {
        const city = data.split("_")[1];
        const user = new User({
            userId: ctx.from.id, username: ctx.from.username,
            tariff: ctx.session.tariff, city,
            name: `Водитель #${Math.floor(Math.random()*9000)+1000}`,
            isAllowed: (ctx.from.id === ADMIN_ID)
        });
        await user.save();
        await updateEvents(city); // Сразу парсим события для города новичка
        await ctx.editMessageText(`✅ Регистрация завершена!`);
        await ctx.reply("Добро пожаловать в меню!", { reply_markup: new Keyboard().text("Открыть карту 🔥").row().text("События города 🎭").text("Цены на топливо ⛽️").resized() });
    }
    
    // Остальные обработчики (doneorder, manage, allow, delete) без изменений...
    if (data.startsWith("doneorder_")) {
        await Order.findByIdAndDelete(data.split("_")[1]);
        await ctx.editMessageText("✅ Выполнено.");
    }
});

bot.start();
http.createServer((req, res) => res.end("ok")).listen(process.env.PORT || 8080);