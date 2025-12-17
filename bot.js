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

// Схема событий с координатами и авто-удалением (TTL)
const eventSchema = new mongoose.Schema({
    city: String,
    title: String,
    address: String,
    lat: Number,
    lng: Number,
    link: String,
    expireAt: { type: Date, index: { expires: 0 } } // Удалит документ ровно в это время
});
const Event = mongoose.model("Event", eventSchema);

const Order = mongoose.model("Order", new mongoose.Schema({
    userId: Number, username: String, carNumber: String, phone: String,
    status: { type: String, default: "Новая" }, date: { type: Date, default: Date.now }
}));

bot.use(session({ initial: () => ({ step: "idle" }) }));

// --- 🗺️ ГЕОКОДЕР (Адрес -> Координаты) ---
async function getCoords(address, city) {
    try {
        const fullAddr = `${city}, ${address}`;
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(fullAddr)}&limit=1`;
        const { data } = await axios.get(url, { headers: { 'User-Agent': 'TaxiHotMapBot' } });
        if (data && data.length > 0) {
            return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        }
    } catch (e) { console.error("Ошибка геокодинга:", e.message); }
    return null;
}

// --- 🌐 ПАРСЕР МЕРОПРИЯТИЙ (20 событий + Координаты) ---
async function updateEvents(city) {
    const slugs = { "Москва": "msk", "Санкт-Петербург": "spb", "Казань": "kzn" };
    const slug = slugs[city] || "msk";
    
    try {
        // Используем API KudaGo, так как оно отдает адреса сразу (парсить сайт сложнее)
        const url = `https://kudago.com/public-api/v1.4/events/?location=${slug}&fields=title,place,dates,site_url&page_size=20&expand=place`;
        const { data } = await axios.get(url);
        
        const validEvents = [];
        for (const item of data.results) {
            if (item.place && item.place.address) {
                // Берем дату окончания последнего сеанса
                const lastDate = item.dates[item.dates.length - 1].end * 1000; 
                const expireAt = new Date(lastDate);

                // Если событие еще не закончилось
                if (dayjs(expireAt).isAfter(dayjs())) {
                    const coords = await getCoords(item.place.address, city);
                    if (coords) {
                        validEvents.push({
                            city,
                            title: item.title,
                            address: item.place.address,
                            lat: coords.lat,
                            lng: coords.lng,
                            link: item.site_url,
                            expireAt: expireAt
                        });
                    }
                }
            }
        }

        if (validEvents.length > 0) {
            await Event.deleteMany({ city }); // Очистка старых
            await Event.insertMany(validEvents);
            return validEvents.length;
        }
    } catch (e) { console.error("Ошибка обновления событий:", e.message); }
    return 0;
}

// --- 🚀 ОБРАБОТКА КОМАНД ---

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
        if (ctx.from.id === ADMIN_ID) menu.row().text("Список водителей 📋").text("Обновить карту 🔄");
        await ctx.reply("🏠 Главное меню", { reply_markup: menu });
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;

    if (text === "Обновить карту 🔄" && userId === ADMIN_ID) {
        await ctx.reply("⏳ Собираю топ-20 событий и ставлю метки на карту... Это займет около минуты.");
        const countMsk = await updateEvents("Москва");
        const countSpb = await updateEvents("Санкт-Петербург");
        return ctx.reply(`✅ Карта обновлена!\nМосква: ${countMsk} меток\nПитер: ${countSpb} меток.\nСобытия удалятся сами по истечению времени.`);
    }

    if (text === "События города 🎭") {
        const u = await User.findOne({ userId });
        const events = await Event.find({ city: u?.city || "Москва" }).limit(10);
        if (events.length === 0) return ctx.reply("📅 На карте пока нет активных меток.");
        
        let msg = `🔥 **Топ событий для работы (на карте):**\n\n`;
        events.forEach((e) => {
            msg += `📍 ${e.title}\n⏰ До: ${dayjs(e.expireAt).format("DD.MM HH:mm")}\n\n`;
        });
        return ctx.reply(msg);
    }

    if (text === "Открыть карту 🔥") {
        const u = await User.findOne({ userId });
        if (u?.isAllowed) return ctx.reply("📍 Карта:", { reply_markup: new InlineKeyboard().webApp("Открыть карту", webAppUrl) });
        return ctx.reply("🚫 Нет доступа.");
    }

    // Регистрация (город)
    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        const kb = new InlineKeyboard();
        ["Москва", "Санкт-Петербург", "Казань"].forEach(c => kb.text(c, `regcity_${c}`).row());
        await ctx.reply("🏙 Выберите город:", { reply_markup: kb });
    }
    
    // Аналитика (упрощенно)
    if (text === "Аналитика 📊") {
        return ctx.reply("💰 Стоимость аналитики: 2490 ₽. Нажмите Согласен для ввода данных.", {
            reply_markup: new InlineKeyboard().text("✅ Согласен", "analyt_start")
        });
    }
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("regcity_")) {
        const city = data.split("_")[1];
        await new User({ userId: ctx.from.id, city, isAllowed: (ctx.from.id === ADMIN_ID) }).save();
        await ctx.editMessageText("✅ Регистрация завершена! Нажмите /start");
    }
    if (data === "analyt_start") {
        await ctx.reply("Введите номер авто:");
        ctx.session.step = "analyt_wait_car";
    }
});

bot.start();
http.createServer((req, res) => res.end("ok")).listen(process.env.PORT || 8080);