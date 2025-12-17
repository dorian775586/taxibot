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

const Event = mongoose.model("Event", new mongoose.Schema({
    city: String,
    title: String,
    address: String,
    lat: Number,
    lng: Number,
    link: String,
    expireAt: { type: Date, index: { expires: 0 } } // TTL-индекс для авто-удаления
}));

const Order = mongoose.model("Order", new mongoose.Schema({
    userId: Number, username: String, carNumber: String, phone: String,
    status: { type: String, default: "Новая" }, date: { type: Date, default: Date.now }
}));

const Fuel = mongoose.model("Fuel", new mongoose.Schema({
    city: { type: String, unique: true },
    ai92: String, ai95: String, dt: String, gas: String, lastUpdate: Date
}));

bot.use(session({ initial: () => ({ step: "idle", tariff: null, carNumber: null }) }));

// --- 🗺️ ГЕОКОДЕР (Адрес -> Координаты) ---
async function getCoords(address, city) {
    try {
        const fullAddr = `${city}, ${address}`;
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(fullAddr)}&limit=1`;
        const { data } = await axios.get(url, { headers: { 'User-Agent': 'TaxiHotMapBot' }, timeout: 5000 });
        if (data && data.length > 0) {
            return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        }
    } catch (e) { console.error("Геокодинг провален:", e.message); }
    return null;
}

// --- 🌐 ПАРСЕР МЕРОПРИЯТИЙ (KudaGo API) ---
async function updateEvents(city) {
    const slugs = { "Москва": "msk", "Санкт-Петербург": "spb", "Казань": "kzn" };
    const slug = slugs[city] || "msk";
    try {
        const nowUnix = Math.floor(Date.now() / 1000);
        const url = `https://kudago.com/public-api/v1.4/events/?location=${slug}&fields=title,place,dates,site_url&page_size=20&expand=place&actual_since=${nowUnix}`;
        const { data } = await axios.get(url);
        
        const validEvents = [];
        const todayEnd = dayjs().endOf('day').unix();

        for (const item of data.results) {
            if (item.place && item.place.address) {
                // Ищем время окончания на сегодня или ставим конец дня
                const session = item.dates.find(d => d.end >= nowUnix);
                const expireAt = session ? new Date(session.end * 1000) : dayjs().endOf('day').toDate();

                const coords = await getCoords(item.place.address, city);
                if (coords) {
                    validEvents.push({
                        city,
                        title: item.title.charAt(0).toUpperCase() + item.title.slice(1),
                        address: item.place.address,
                        lat: coords.lat,
                        lng: coords.lng,
                        link: item.site_url,
                        expireAt: expireAt
                    });
                }
                // Небольшая пауза для Nominatim (чтобы не забанили)
                await new Promise(r => setTimeout(r, 700));
            }
        }

        if (validEvents.length > 0) {
            await Event.deleteMany({ city });
            await Event.insertMany(validEvents);
            return validEvents.length;
        }
    } catch (e) { console.error("Ошибка обновления событий:", e.message); }
    return 0;
}

// --- ⛽️ ПАРСЕР ТОПЛИВА ---
async function fetchFuelPrices(cityName) {
    try {
        const cityTranslit = { "Москва": "moskva", "Санкт-Петербург": "sankt-peterburg", "Казань": "kazan" };
        const slug = cityTranslit[cityName] || "moskva";
        const { data } = await axios.get(`https://fuelprices.ru/${slug}`, { timeout: 7000, headers: { 'User-Agent': 'Mozilla/5.0' } });
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

// --- 🚀 ОБРАБОТКА ТЕКСТА ---
bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;

    if (text === "/start") {
        let user = await User.findOne({ userId });
        if (!user) {
            ctx.session.step = "wait_tariff";
            return ctx.reply("🚕 Выберите тариф:", { reply_markup: new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime() });
        }
        const menu = new Keyboard().text("Открыть карту 🔥").row().text("События сегодня 🎭").text("Цены на топливо ⛽️").row().text("Аналитика 📊").text("Мой профиль 👤").resized();
        if (userId === ADMIN_ID) menu.row().text("Список водителей 📋").text("Заявки 📂").text("Обновить карту 🔄");
        return ctx.reply("🏠 Главное меню", { reply_markup: menu });
    }

    if (text === "Обновить карту 🔄" && userId === ADMIN_ID) {
        await ctx.reply("⏳ Парсинг 20 событий и геокодинг запущен... (около 1 мин)");
        const c1 = await updateEvents("Москва");
        const c2 = await updateEvents("Санкт-Петербург");
        return ctx.reply(`✅ Готово!\nМосква: ${c1} точек\nПитер: ${c2} точек.`);
    }

    if (text === "События сегодня 🎭") {
        const u = await User.findOne({ userId });
        const evs = await Event.find({ city: u?.city || "Москва" }).limit(10);
        if (evs.length === 0) return ctx.reply("📍 На карте пока пусто.");
        let m = "🔥 **Актуальные точки:**\n\n";
        evs.forEach(e => m += `• ${e.title}\n⏰ До: ${dayjs(e.expireAt).format("HH:mm")}\n\n`);
        return ctx.reply(m, { parse_mode: "Markdown" });
    }

    if (text === "Цены на топливо ⛽️") {
        const u = await User.findOne({ userId });
        const f = await fetchFuelPrices(u?.city || "Москва");
        if (!f) return ctx.reply("❌ Ошибка связи с сервером цен.");
        return ctx.reply(`⛽️ **${u.city}:**\n92: ${f.ai92}р\n95: ${f.ai95}р\nДТ: ${f.dt}р`, { parse_mode: "Markdown" });
    }

    if (text === "Аналитика 📊") {
        const txt = "Аналитика вашего аккаунта ЯндексGo на теневой бан и чек.\n💰 Цена: 2490 ₽";
        return ctx.reply(txt, { reply_markup: new InlineKeyboard().text("✅ Согласен", "analyt_start").text("❌ Отмена", "idle") });
    }

    if (ctx.session.step === "analyt_wait_car") {
        ctx.session.carNumber = text;
        ctx.session.step = "analyt_wait_phone";
        return ctx.reply("📱 Введите номер телефона:");
    }

    if (ctx.session.step === "analyt_wait_phone") {
        await new Order({ userId, username: ctx.from.username, carNumber: ctx.session.carNumber, phone: text }).save();
        ctx.session.step = "idle";
        await ctx.reply("✅ Заявка отправлена!");
        return bot.api.sendMessage(ADMIN_ID, `🔥 Заявка на аналитику от @${ctx.from.username}\nТел: ${text}`);
    }

    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        const kb = new InlineKeyboard();
        ["Москва", "Санкт-Петербург", "Казань"].forEach(c => kb.text(c, `regcity_${c}`).row());
        return ctx.reply("🏙 Ваш город:", { reply_markup: kb });
    }

    if (text === "Открыть карту 🔥") {
        const u = await User.findOne({ userId });
        if (u?.isAllowed) return ctx.reply("📍 Карта:", { reply_markup: new InlineKeyboard().webApp("Открыть", webAppUrl) });
        return ctx.reply("🚫 Доступ закрыт.");
    }
});

// --- 🖱 ОБРАБОТКА КНОПОК ---
bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("regcity_")) {
        const city = data.split("_")[1];
        await new User({ userId: ctx.from.id, city, tariff: ctx.session.tariff, username: ctx.from.username, isAllowed: (ctx.from.id === ADMIN_ID) }).save();
        await ctx.editMessageText("✅ Регистрация завершена! Напишите /start");
    }
    if (data === "analyt_start") {
        ctx.session.step = "analyt_wait_car";
        await ctx.editMessageText("🔢 Введите госномер авто:");
    }
});

// --- 🌐 API СЕРВЕР ДЛЯ WEBAPP КАРТЫ ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.url.startsWith('/api/points')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const city = url.searchParams.get('city') || "Москва";
        const events = await Event.find({ city });
        res.end(JSON.stringify(events));
    } else {
        res.end(JSON.stringify({ status: "running" }));
    }
});

bot.start();
server.listen(process.env.PORT || 8080);