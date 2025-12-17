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
    expireAt: { type: Date, index: { expires: 0 } } // Точка сама удалится из базы по истечении времени
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
    } catch (e) { console.error("Геокодинг не удался:", e.message); }
    return null;
}

// --- 🌐 ПАРСЕР МЕРОПРИЯТИЙ (KudaGo API) ---
async function updateEvents(city) {
    const slugs = { "Москва": "msk", "Санкт-Петербург": "spb", "Казань": "kzn" };
    const slug = slugs[city] || "msk";
    try {
        const nowUnix = Math.floor(Date.now() / 1000);
        // Запрос 20 актуальных событий
        const url = `https://kudago.com/public-api/v1.4/events/?location=${slug}&fields=title,place,dates,site_url&page_size=20&expand=place&actual_since=${nowUnix}`;
        const { data } = await axios.get(url);
        
        const validEvents = [];

        for (const item of data.results) {
            if (item.place && item.place.address) {
                // Ищем сеанс, который заканчивается позже всего сегодня
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
                // Задержка, чтобы не заблокировал геокодер
                await new Promise(r => setTimeout(r, 800));
            }
        }

        if (validEvents.length > 0) {
            await Event.deleteMany({ city });
            await Event.insertMany(validEvents);
            return validEvents.length;
        }
    } catch (e) { console.error("Ошибка парсера:", e.message); }
    return 0;
}

// --- 🚀 ОСНОВНАЯ ЛОГИКА БОТА ---
bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;

    if (text === "/start") {
        let user = await User.findOne({ userId });
        if (!user) {
            ctx.session.step = "wait_tariff";
            const kb = new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime();
            return ctx.reply("🚕 Добро пожаловать! Выберите тариф:", { reply_markup: kb });
        }
        const menu = new Keyboard().text("Открыть карту 🔥").row().text("События сегодня 🎭").text("Цены на топливо ⛽️").row().text("Аналитика 📊").text("Мой профиль 👤").resized();
        if (userId === ADMIN_ID) menu.row().text("Список водителей 📋").text("Обновить карту 🔄");
        return ctx.reply("🏠 Главное меню", { reply_markup: menu });
    }

    if (text === "Обновить карту 🔄" && userId === ADMIN_ID) {
        await ctx.reply("⏳ Начинаю сбор 20 событий для Москвы и СПБ. Это займет около 1-2 минут...");
        const mskCount = await updateEvents("Москва");
        const spbCount = await updateEvents("Санкт-Петербург");
        return ctx.reply(`✅ Карта обновлена!\n📍 Москва: ${mskCount} точек\n📍 Питер: ${spbCount} точек.`);
    }

    if (text === "Открыть карту 🔥") {
        const u = await User.findOne({ userId });
        if (u?.isAllowed) {
            // Передаем город пользователя в URL WebApp
            const personalUrl = `${webAppUrl}?city=${encodeURIComponent(u.city || "Москва")}`;
            return ctx.reply("📍 Ваша карта активных точек:", { 
                reply_markup: new InlineKeyboard().webApp("Открыть карту", personalUrl) 
            });
        }
        return ctx.reply("🚫 У вас пока нет доступа к карте. Обратитесь к администратору.");
    }

    if (text === "События сегодня 🎭") {
        const u = await User.findOne({ userId });
        const evs = await Event.find({ city: u?.city || "Москва" }).limit(10);
        if (evs.length === 0) return ctx.reply("📍 Сейчас нет активных мероприятий на карте.");
        let msg = `🎭 **Мероприятия в г. ${u.city}:**\n\n`;
        evs.forEach(e => msg += `• ${e.title}\n⏰ Развоз до: ${dayjs(e.expireAt).format("HH:mm")}\n\n`);
        return ctx.reply(msg, { parse_mode: "Markdown" });
    }

    // Обработка регистрации
    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        const kb = new InlineKeyboard();
        ["Москва", "Санкт-Петербург", "Казань"].forEach(c => kb.text(c, `regcity_${c}`).row());
        return ctx.reply("🏙 Выберите ваш город:", { reply_markup: kb });
    }
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("regcity_")) {
        const city = data.split("_")[1];
        const user = new User({
            userId: ctx.from.id, 
            username: ctx.from.username,
            city: city,
            tariff: ctx.session.tariff,
            name: `Водитель #${Math.floor(Math.random()*9000)+1000}`,
            isAllowed: (ctx.from.id === ADMIN_ID)
        });
        await user.save();
        await ctx.editMessageText(`✅ Регистрация завершена! Ваш город: ${city}. Нажмите /start для входа.`);
    }
});

// --- 🌐 API СЕРВЕР ДЛЯ КАРТЫ ---
const server = http.createServer(async (req, res) => {
    // Разрешаем запросы с любого домена (CORS)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.url.startsWith('/api/points')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const city = url.searchParams.get('city') || "Москва";
        
        try {
            const events = await Event.find({ city });
            res.end(JSON.stringify(events));
        } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "DB Error" }));
        }
    } else {
        res.end(JSON.stringify({ status: "ok", bot: "active" }));
    }
});

// Запуск
bot.start();
server.listen(process.env.PORT || 8080);