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
mongoose.connect(mongoUri).then(() => console.log("✅ MongoDB Connected"));

const User = mongoose.model("User", new mongoose.Schema({
    userId: { type: Number, unique: true },
    username: String, 
    city: String, 
    tariff: String,
    isAllowed: { type: Boolean, default: false },
    regDate: { type: Date, default: Date.now }
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
            
            const events = data.results
                .filter(i => i.place && i.place.coords)
                .map(i => ({
                    city: city.name,
                    title: i.title.charAt(0).toUpperCase() + i.title.slice(1),
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
        } catch (e) { console.error(`Ошибка парсинга ${city.name}:`, e.message); }
    }
    return total;
}

// --- 🚀 ЛОГИКА БОТА ---
bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;
    
    try {
        const user = await User.findOne({ userId });

        if (text === "/start") {
            if (!user) {
                ctx.session.step = "wait_tariff";
                const kb = new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime();
                return ctx.reply("🚕 Добро пожаловать! Выберите ваш рабочий тариф:", { reply_markup: kb });
            }
            const menu = new Keyboard()
                .text("Открыть карту 🔥").row()
                .text("События сегодня 🎭").text("Цены на топливо ⛽️").row()
                .text("Аналитика 📊").text("Мой профиль 👤").resized();
            
            if (userId === ADMIN_ID) {
                menu.row().text("Список водителей 📋").text("Обновить карту 🔄");
            }
            return ctx.reply("🏠 Главное меню", { reply_markup: menu });
        }

        // 1. ОБНОВИТЬ КАРТУ (АДМИН)
        if (text === "Обновить карту 🔄" && userId === ADMIN_ID) {
            await ctx.reply("📡 Сбор данных по всем городам запущен... Это займет около 30 сек.");
            const count = await updateAllCities();
            return ctx.reply(`✅ Карта обновлена! Всего точек: ${count}`);
        }

        // 2. СПИСОК ВОДИТЕЛЕЙ (АДМИН)
        if (text === "Список водителей 📋" && userId === ADMIN_ID) {
            const drivers = await User.find().limit(40).sort({ regDate: -1 });
            if (!drivers.length) return ctx.reply("Водителей пока нет.");
            let msg = "👥 **Последние регистрации:**\n\n";
            drivers.forEach(d => {
                msg += `${d.isAllowed ? '✅' : '⏳'} ${d.city} | ${d.tariff} | @${d.username || 'id'+d.userId}\n`;
            });
            return ctx.reply(msg, { parse_mode: "Markdown" });
        }

        // 3. ОТКРЫТЬ КАРТУ
        if (text === "Открыть карту 🔥") {
            if (user?.isAllowed || userId === ADMIN_ID) {
                const url = `${webAppUrl}?city=${encodeURIComponent(user?.city || "Москва")}`;
                return ctx.reply("📍 Нажмите кнопку ниже, чтобы открыть карту:", {
                    reply_markup: new InlineKeyboard().webApp("Запустить HotMap", url)
                });
            }
            return ctx.reply("🚫 Доступ к карте ограничен. Обратитесь к @bogat777 для подтверждения профиля.");
        }

        // 4. СОБЫТИЯ
        if (text === "События сегодня 🎭") {
            const events = await Event.find({ city: user?.city || "Москва" }).limit(10);
            if (!events.length) return ctx.reply("📍 В вашем городе пока нет активных точек.");
            let msg = `🎭 **Мероприятия (${user?.city}):**\n\n`;
            events.forEach(e => msg += `🔥 ${e.title}\n📍 ${e.address}\n⏰ До ${dayjs(e.expireAt).format("HH:mm")}\n\n`);
            return ctx.reply(msg, { parse_mode: "Markdown" });
        }

        // 5. МОЙ ПРОФИЛЬ
        if (text === "Мой профиль 👤") {
            const status = (user?.isAllowed || userId === ADMIN_ID) ? "✅ Активен" : "⏳ Ожидает проверки";
            const info = `👤 **Ваш профиль:**\n\n🆔 ID: \`${userId}\`\n🚕 Тариф: ${user?.tariff || "Не выбран"}\n🏙 Город: ${user?.city || "Не выбран"}\n🚦 Доступ: ${status}`;
            return ctx.reply(info, { parse_mode: "Markdown" });
        }

        // 6. АНАЛИТИКА
        if (text === "Аналитика 📊") {
            const uCount = await User.countDocuments();
            const eCount = await Event.countDocuments();
            return ctx.reply(`📊 **Статистика HotMap:**\n\n👥 Водителей в системе: ${uCount}\n🔥 Точек на карте: ${eCount}\n🏙 Городов: ${CITIES_LIST.length}`);
        }

        // 7. ТОПЛИВО
        if (text === "Цены на топливо ⛽️") {
            return ctx.reply(`⛽️ **Средние цены (${user?.city || "РФ"}):**\n\nАИ-95: 56.40₽\nАИ-92: 51.20₽\nДТ: 64.10₽\nГаз: 28.50₽\n\n_Данные обновляются раз в сутки_`, { parse_mode: "Markdown" });
        }

        // --- РЕГИСТРАЦИЯ ---
        if (ctx.session.step === "wait_tariff") {
            ctx.session.tariff = text;
            ctx.session.step = "idle";
            const kb = new InlineKeyboard();
            CITIES_LIST.forEach(c => kb.text(c.name, `regcity_${c.name}`).row());
            return ctx.reply("🏙 В каком городе работаете?", { reply_markup: kb });
        }

    } catch (err) {
        console.error("ОШИБКА БОТА:", err);
        return ctx.reply("⚠️ Произошла внутренняя ошибка. Попробуйте нажать /start");
    }
});

bot.on("callback_query:data", async (ctx) => {
    if (ctx.callbackQuery.data.startsWith("regcity_")) {
        const city = ctx.callbackQuery.data.split("_")[1];
        await User.findOneAndUpdate({ userId: ctx.from.id }, {
            userId: ctx.from.id,
            username: ctx.from.username,
            city: city,
            tariff: ctx.session.tariff,
            isAllowed: (ctx.from.id === ADMIN_ID)
        }, { upsert: true });
        await ctx.editMessageText(`✅ Регистрация завершена!\n📍 Город: ${city}\n🚕 Тариф: ${ctx.session.tariff}\n\nНажмите /start для входа в меню.`);
    }
});

// --- API СЕРВЕР ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.url.startsWith('/api/points')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const city = url.searchParams.get('city');
        const filter = (city && city !== "undefined") ? { city } : {}; 
        const events = await Event.find(filter);
        res.end(JSON.stringify(events));
    } else {
        res.end(JSON.stringify({ status: "active" }));
    }
});

bot.start();
server.listen(process.env.PORT || 8080);