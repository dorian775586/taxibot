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

// Список городов-миллионников
const CITIES_LIST = [
    { name: "Москва", slug: "msk" },
    { name: "Санкт-Петербург", slug: "spb" },
    { name: "Казань", slug: "kzn" },
    { name: "Новосибирск", slug: "nsk" },
    { name: "Екатеринбург", slug: "ekb" },
    { name: "Нижний Новгород", slug: "nnv" }
];

// --- 🗄️ БАЗА ДАННЫХ ---
mongoose.connect(mongoUri);

const User = mongoose.model("User", new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: String, tariff: String, city: String,
    isAllowed: { type: Boolean, default: false },
    username: String,
    regDate: { type: Date, default: Date.now }
}));

const Event = mongoose.model("Event", new mongoose.Schema({
    city: String,
    title: String,
    address: String,
    lat: Number,
    lng: Number,
    link: String,
    expireAt: { type: Date, index: { expires: 0 } }
}));

bot.use(session({ initial: () => ({ step: "idle", tariff: null }) }));

// --- 🌐 ПАРСЕР (Глобальный по всем городам) ---
async function updateAllCities() {
    let total = 0;
    for (const city of CITIES_LIST) {
        try {
            const nowUnix = Math.floor(Date.now() / 1000);
            const url = `https://kudago.com/public-api/v1.4/events/?location=${city.slug}&fields=title,place,dates,site_url&page_size=35&expand=place&actual_since=${nowUnix}`;
            const { data } = await axios.get(url);
            
            const validEvents = data.results
                .filter(item => item.place && item.place.coords)
                .map(item => ({
                    city: city.name,
                    title: item.title.charAt(0).toUpperCase() + item.title.slice(1),
                    address: item.place.address,
                    lat: item.place.coords.lat,
                    lng: item.place.coords.lon,
                    link: item.site_url,
                    expireAt: item.dates[0]?.end ? new Date(item.dates[0].end * 1000) : dayjs().add(6, 'hour').toDate()
                }));

            if (validEvents.length > 0) {
                await Event.deleteMany({ city: city.name });
                await Event.insertMany(validEvents);
                total += validEvents.length;
            }
        } catch (e) { console.error(`Ошибка города ${city.name}:`, e.message); }
    }
    return total;
}

// --- 🚀 ОСНОВНАЯ ЛОГИКА БОТА ---
bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    if (text === "/start") {
        if (!user) {
            ctx.session.step = "wait_tariff";
            const kb = new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime();
            return ctx.reply("🚕 Добро пожаловать в HotMap Taxi! Выберите ваш рабочий тариф:", { reply_markup: kb });
        }
        const menu = new Keyboard()
            .text("Открыть карту 🔥").row()
            .text("События сегодня 🎭").text("Цены на топливо ⛽️").row()
            .text("Аналитика 📊").text("Мой профиль 👤").resized();
        if (userId === ADMIN_ID) menu.row().text("Обновить карту 🔄");
        return ctx.reply("🏠 Главное меню", { reply_markup: menu });
    }

    // 1. ОБНОВЛЕНИЕ (Админ)
    if (text === "Обновить карту 🔄" && userId === ADMIN_ID) {
        await ctx.reply("📡 Запускаю сбор данных по всем миллионникам... Ждите.");
        const count = await updateAllCities();
        return ctx.reply(`✅ Готово! Собрано точек: ${count}`);
    }

    // 2. КАРТА
    if (text === "Открыть карту 🔥") {
        if (user?.isAllowed) {
            const personalUrl = `${webAppUrl}?city=${encodeURIComponent(user.city || "Москва")}`;
            return ctx.reply("📍 Ваша карта активных точек:", { 
                reply_markup: new InlineKeyboard().webApp("Запустить HotMap", personalUrl) 
            });
        }
        return ctx.reply("🚫 Доступ закрыт. Ожидайте подтверждения от администратора.");
    }

    // 3. СОБЫТИЯ
    if (text === "События сегодня 🎭") {
        const evs = await Event.find({ city: user?.city || "Москва" }).limit(10);
        if (evs.length === 0) return ctx.reply("📍 Точек пока нет. Попробуйте обновить карту.");
        let msg = `🎭 **Топ мест (${user?.city}):**\n\n`;
        evs.forEach(e => msg += `🔥 ${e.title}\n📍 ${e.address}\n⏰ До ${dayjs(e.expireAt).format("HH:mm")}\n\n`);
        return ctx.reply(msg, { parse_mode: "Markdown" });
    }

    // 4. МОЙ ПРОФИЛЬ
    if (text === "Мой профиль 👤") {
        const status = user?.isAllowed ? "✅ Активен" : "⏳ На проверке";
        const info = `👤 **Ваш профиль:**\n\n🆔 ID: \`${userId}\`\n🚕 Тариф: ${user?.tariff}\n🏙 Город: ${user?.city}\n🚦 Статус: ${status}`;
        return ctx.reply(info, { parse_mode: "Markdown" });
    }

    // 5. ТОПЛИВО (Демонстрация данных)
    if (text === "Цены на топливо ⛽️") {
        return ctx.reply(`⛽️ **Средние цены (${user?.city || "РФ"}):**\n\nАИ-95: 56.40₽\nАИ-92: 51.20₽\nДТ: 64.10₽\nГаз: 28.50₽\n\n_Обновлено: сегодня_`, { parse_mode: "Markdown" });
    }

    // 6. АНАЛИТИКА
    if (text === "Аналитика 📊") {
        return ctx.reply("📈 Аналитика спроса временно недоступна. Мы собираем данные о заказах в вашем районе.");
    }

    // --- РЕГИСТРАЦИЯ ---
    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        const kb = new InlineKeyboard();
        CITIES_LIST.forEach(c => kb.text(c.name, `regcity_${c.name}`).row());
        return ctx.reply("🏙 В каком городе работаете?", { reply_markup: kb });
    }
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("regcity_")) {
        const city = data.split("_")[1];
        await User.findOneAndUpdate(
            { userId: ctx.from.id },
            {
                userId: ctx.from.id,
                username: ctx.from.username,
                city: city,
                tariff: ctx.session.tariff,
                isAllowed: (ctx.from.id === ADMIN_ID)
            },
            { upsert: true }
        );
        await ctx.editMessageText(`✅ Регистрация завершена! Город: ${city}.\n\nНажмите /start, чтобы открыть меню.`);
    }
});

// --- API СЕРВЕР ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.url.startsWith('/api/points')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const city = url.searchParams.get('city') || "Москва";
        const events = await Event.find({ city });
        res.end(JSON.stringify(events));
    } else {
        res.end(JSON.stringify({ status: "ok" }));
    }
});

bot.start();
server.listen(process.env.PORT || 8080);