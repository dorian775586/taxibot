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
        if (text === "Обновить карту 🔄") {
            if (userId !== ADMIN_ID) return ctx.reply(`🚫 Отказано. Ваш ID: ${userId}`);
            await ctx.reply("📡 Сбор данных по всем городам запущен...");
            const count = await updateAllCities();
            return ctx.reply(`✅ Карта обновлена! Всего точек: ${count}`);
        }

        // 2. СПИСОК ВОДИТЕЛЕЙ (АДМИН)
        if (text === "Список водителей 📋") {
            if (userId !== ADMIN_ID) return ctx.reply(`🚫 Отказано. Ваш ID: ${userId}`);
            
            const drivers = await User.find().limit(50).sort({ regDate: -1 }).lean();
            if (!drivers.length) return ctx.reply("📭 Водителей в базе пока нет.");
            
            let msg = "👥 **Список водителей (последние 50):**\n\n";
            drivers.forEach((d, i) => {
                const status = d.isAllowed ? '✅' : '⏳';
                const username = d.username ? `@${d.username}` : `id:${d.userId}`;
                msg += `${i+1}. ${status} ${d.city || '??'} | ${d.tariff || '??'} | ${username}\n`;
            });
            
            return ctx.reply(msg, { parse_mode: "Markdown" });
        }

        // 3. ОТКРЫТЬ КАРТУ
        if (text === "Открыть карту 🔥") {
            if (user?.isAllowed || userId === ADMIN_ID) {
                const url = `${webAppUrl}?city=${encodeURIComponent(user?.city || "Москва")}`;
                return ctx.reply("📍 Карта горячих точек:", {
                    reply_markup: new InlineKeyboard().webApp("Открыть HotMap", url)
                });
            }
            return ctx.reply("🚫 Доступ ограничен. Напишите @bogat777");
        }

        // 4. СОБЫТИЯ
        if (text === "События сегодня 🎭") {
            const events = await Event.find({ city: user?.city || "Москва" }).limit(10);
            if (!events.length) return ctx.reply("📍 Активных точек в вашем городе не найдено.");
            let msg = `🎭 **Мероприятия (${user?.city || "Москва"}):**\n\n`;
            events.forEach(e => msg += `🔥 ${e.title}\n⏰ До ${dayjs(e.expireAt).format("HH:mm")}\n\n`);
            return ctx.reply(msg, { parse_mode: "Markdown" });
        }

        // 5. МОЙ ПРОФИЛЬ
        if (text === "Мой профиль 👤") {
            const status = (user?.isAllowed || userId === ADMIN_ID) ? "✅ Доступ разрешен" : "⏳ На проверке";
            const info = `👤 **Профиль:**\n\n🆔 ID: \`${userId}\`\n🏙 Город: ${user?.city || "Не указан"}\n🚕 Тариф: ${user?.tariff || "Не выбран"}\n🚦 Статус: ${status}`;
            return ctx.reply(info, { parse_mode: "Markdown" });
        }

        // 6. АНАЛИТИКА
        if (text === "Аналитика 📊") {
            const uCount = await User.countDocuments();
            const eCount = await Event.countDocuments();
            return ctx.reply(`📊 **Статистика:**\n\n👥 Водителей: ${uCount}\n🔥 Точек: ${eCount}\n🏙 Городов: ${CITIES_LIST.length}`);
        }

        // 7. ТОПЛИВО
        if (text === "Цены на топливо ⛽️") {
            return ctx.reply(`⛽️ **Средние цены:**\n\nАИ-95: 56.40₽\nАИ-92: 51.20₽\nДТ: 64.10₽\nГаз: 28.50₽`);
        }

        // --- РЕГИСТРАЦИЯ ---
        if (ctx.session.step === "wait_tariff") {
            ctx.session.tariff = text;
            ctx.session.step = "idle";
            const kb = new InlineKeyboard();
            CITIES_LIST.forEach(c => kb.text(c.name, `regcity_${c.name}`).row());
            return ctx.reply("🏙 Выберите ваш основной город:", { reply_markup: kb });
        }

    } catch (err) {
        console.error("ОШИБКА:", err);
        return ctx.reply("⚠️ Ошибка. Нажмите /start");
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
        await ctx.editMessageText(`✅ Готово! Город: ${city}, Тариф: ${ctx.session.tariff}. Нажмите /start`);
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
        res.end(JSON.stringify({ status: "ok" }));
    }
});

bot.start();
server.listen(process.env.PORT || 8080);