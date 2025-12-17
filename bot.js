const { Bot, Keyboard, InlineKeyboard, session } = require("grammy");
const mongoose = require("mongoose");
const http = require("http");
const dayjs = require("dayjs");
const axios = require("axios");

// --- ⚙️ НАСТРОЙКИ ---
const token = "7973955726:AAFpMltfoqwO902Q1su5j6HWipPxEJYM3-o";
const webAppUrl = "https://hotmaptaxi-git-main-dorians-projects-14978635.vercel.app";
const mongoUri = "mongodb+srv://user775586:user775586@cluster0.36spuej.mongodb.net/?appName=Cluster0"; 
const ADMIN_ID = 623203896; 

const bot = new Bot(token);

const CITIES_LIST = [
    { name: "Москва", slug: "msk" },
    { name: "Санкт-Петербург", slug: "spb" },
    { name: "Казань", slug: "kzn" },
    { name: "Новосибирск", slug: "nsk" },
    { name: "Екатеринбург", slug: "ekb" },
    { name: "Нижний Новгород", slug: "nnv" },
    { name: "Челябинск", slug: "che" }
];

// --- 🗄️ БАЗА ДАННЫХ ---
mongoose.connect(mongoUri);

const User = mongoose.model("User", new mongoose.Schema({
    userId: { type: Number, unique: true },
    username: String, city: String, tariff: String,
    isAllowed: { type: Boolean, default: false }
}));

const Event = mongoose.model("Event", new mongoose.Schema({
    city: String, title: String, address: String, lat: Number, lng: Number, expireAt: Date
}));

bot.use(session({ initial: () => ({ step: "idle", tariff: null }) }));

// --- 🌐 ГЛОБАЛЬНЫЙ ПАРСЕР ---
async function updateAllCities() {
    let total = 0;
    for (const city of CITIES_LIST) {
        try {
            const nowUnix = Math.floor(Date.now() / 1000);
            const url = `https://kudago.com/public-api/v1.4/events/?location=${city.slug}&fields=title,place,dates&page_size=35&expand=place&actual_since=${nowUnix}`;
            const { data } = await axios.get(url);
            
            const events = data.results.filter(i => i.place && i.place.coords).map(i => ({
                city: city.name,
                title: i.title,
                address: i.place.address,
                lat: i.place.coords.lat,
                lng: i.place.coords.lon,
                expireAt: i.dates[0]?.end ? new Date(i.dates[0].end * 1000) : dayjs().add(5, 'hour').toDate()
            }));

            if (events.length > 0) {
                await Event.deleteMany({ city: city.name });
                await Event.insertMany(events);
                total += events.length;
            }
        } catch (e) { console.log(e.message); }
    }
    return total;
}

// --- 🚀 ЛОГИКА БОТА ---
bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    if (text === "/start") {
        if (!user) {
            ctx.session.step = "wait_tariff";
            return ctx.reply("🚕 Выберите тариф:", { reply_markup: new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized() });
        }
        const menu = new Keyboard().text("Открыть карту 🔥").row().text("События сегодня 🎭").text("Мой профиль 👤").row().text("Аналитика 📊").text("Цены на топливо ⛽️").resized();
        if (userId === ADMIN_ID) menu.row().text("Список водителей 📋").text("Обновить карту 🔄");
        return ctx.reply("🏠 Меню", { reply_markup: menu });
    }

    if (text === "Обновить карту 🔄" && userId === ADMIN_ID) {
        await ctx.reply("📡 Парсинг запущен...");
        const count = await updateAllCities();
        return ctx.reply(`✅ Готово: ${count} точек.`);
    }

    if (text === "Список водителей 📋" && userId === ADMIN_ID) {
        const drivers = await User.find().limit(20);
        let msg = "👥 **Последние водители:**\n\n" + drivers.map(d => `${d.isAllowed ? '✅' : '⏳'} ${d.city} | @${d.username}`).join('\n');
        return ctx.reply(msg, { parse_mode: "Markdown" });
    }

    if (text === "Аналитика 📊") {
        const uCount = await User.countDocuments();
        const eCount = await Event.countDocuments();
        return ctx.reply(`📊 Всего юзеров: ${uCount}\n🔥 Всего точек: ${eCount}`);
    }

    if (text === "Мой профиль 👤") {
        return ctx.reply(`👤 Профиль: @${user?.username}\n🏙 Город: ${user?.city}\n🚕 Тариф: ${user?.tariff}\n🚦 Доступ: ${user?.isAllowed ? "Есть" : "Нет"}`);
    }

    if (text === "Открыть карту 🔥") {
        const url = `${webAppUrl}?city=${encodeURIComponent(user?.city || "Москва")}`;
        return ctx.reply("Карта:", { reply_markup: new InlineKeyboard().webApp("Открыть", url) });
    }

    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        const kb = new InlineKeyboard();
        CITIES_LIST.forEach(c => kb.text(c.name, `reg_${c.name}`).row());
        return ctx.reply("Выберите город:", { reply_markup: kb });
    }
});

bot.on("callback_query:data", async (ctx) => {
    if (ctx.callbackQuery.data.startsWith("reg_")) {
        const city = ctx.callbackQuery.data.split("_")[1];
        await User.findOneAndUpdate({ userId: ctx.from.id }, {
            userId: ctx.from.id, username: ctx.from.username, city, tariff: ctx.session.tariff, isAllowed: (ctx.from.id === ADMIN_ID)
        }, { upsert: true });
        await ctx.editMessageText("✅ Регистрация завершена! Жми /start");
    }
});

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.startsWith('/api/points')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const city = url.searchParams.get('city');
        const filter = city ? { city } : {}; // Если города в запросе нет, отдаем ВСЕ точки
        const events = await Event.find(filter);
        res.end(JSON.stringify(events));
    } else { res.end(JSON.stringify({ status: "ok" })); }
});

bot.start();
server.listen(process.env.PORT || 8080);