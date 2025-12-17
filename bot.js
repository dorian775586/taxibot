const { Bot, Keyboard, InlineKeyboard, session, GrammyError, HttpError } = require("grammy");
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

bot.catch((err) => {
    console.error(`🔴 Ошибка бота:`, err.error);
});

// --- 🗄️ БАЗА ДАННЫХ ---
mongoose.connect(mongoUri).then(() => console.log("✅ MongoDB подключена"));

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

// --- 🚀 УСКОРЕННЫЙ ПАРСЕР ---
async function updateAllCities() {
    const CITIES_LIST = [
        { name: "Москва", slug: "msk" }, { name: "Санкт-Петербург", slug: "spb" },
        { name: "Казань", slug: "kzn" }, { name: "Новосибирск", slug: "nsk" },
        { name: "Екатеринбург", slug: "ekb" }, { name: "Нижний Новгород", slug: "nnv" },
        { name: "Челябинск", slug: "che" }
    ];
    const nowUnix = Math.floor(Date.now() / 1000);
    const promises = CITIES_LIST.map(async (city) => {
        try {
            const url = `https://kudago.com/public-api/v1.4/events/?location=${city.slug}&fields=title,place,dates&page_size=35&expand=place&actual_since=${nowUnix}`;
            const { data } = await axios.get(url, { timeout: 10000 });
            const events = data.results.filter(i => i.place && i.place.coords).map(i => ({
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
                return events.length;
            }
            return 0;
        } catch (e) { return 0; }
    });
    const results = await Promise.all(promises);
    return results.reduce((a, b) => a + b, 0);
}

// --- 🤖 ЛОГИКА ---
bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    if (text === "/start") {
        if (!user) {
            ctx.session.step = "wait_tariff";
            return ctx.reply("🚕 Выберите ваш тариф:", { 
                reply_markup: new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime() 
            });
        }
        const menu = new Keyboard().text("Открыть карту 🔥").row().text("События сегодня 🎭").text("Цены на топливо ⛽️").row().text("Аналитика 📊").text("Мой профиль 👤").resized();
        if (userId === ADMIN_ID) menu.row().text("Список водителей 📋").text("Обновить карту 🔄");
        return ctx.reply("🏠 Главное меню", { reply_markup: menu });
    }

    if (text === "/clean_database" && userId === ADMIN_ID) {
        await User.deleteMany({ userId: { $ne: ADMIN_ID } });
        return ctx.reply("🧹 База очищена.");
    }

    if (text === "Обновить карту 🔄" && userId === ADMIN_ID) {
        const loadingMsg = await ctx.reply("📡 Обновляю данные...");
        const count = await updateAllCities();
        return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `✅ Готово! Добавлено ${count} точек.`);
    }

    // --- ИСПРАВЛЕННЫЙ СПИСОК (HTML MODE) ---
    if (text === "Список водителей 📋" && userId === ADMIN_ID) {
        const drivers = await User.find().sort({ regDate: -1 }).lean();
        if (!drivers.length) return ctx.reply("📭 Водителей нет.");

        let msg = `<b>👥 Водителей в базе: ${drivers.length}</b>\n\n`;
        drivers.forEach((d, i) => {
            const date = dayjs(d.regDate).format("DD.MM HH:mm");
            const userLink = d.username ? `@${d.username}` : `ID:${d.userId}`;
            // Используем HTML вместо Markdown, чтобы подчеркивания не ломали текст
            const line = `${i+1}. ${date} | ${d.city || '??'} | <code>${userLink}</code>\n`;
            
            if ((msg + line).length > 4000) {
                ctx.reply(msg, { parse_mode: "HTML" });
                msg = "";
            }
            msg += line;
        });
        return ctx.reply(msg, { parse_mode: "HTML" });
    }

    if (text === "Открыть карту 🔥") {
        if (!user?.isAllowed && userId !== ADMIN_ID) return ctx.reply("🚫 Доступ не подтвержден.");
        const url = `${webAppUrl}?city=${encodeURIComponent(user?.city || "Москва")}`;
        return ctx.reply("📍 Карта открыта:", { reply_markup: new InlineKeyboard().webApp("Открыть карту", url) });
    }

    if (text === "Аналитика 📊") {
        const [uCount, eCount] = await Promise.all([User.countDocuments(), Event.countDocuments()]);
        return ctx.reply(`📊 <b>Статистика:</b>\n• Водителей: ${uCount}\n• Точек: ${eCount}`, { parse_mode: "HTML" });
    }

    if (text === "Мой профиль 👤") {
        const status = (user?.isAllowed || userId === ADMIN_ID) ? "Одобрен" : "На проверке";
        return ctx.reply(`👤 <b>Профиль:</b>\n\n🆔 ID: <code>${userId}</code>\n🏙 Город: ${user?.city || "—"}\n🚦 Статус: ${status}`, { parse_mode: "HTML" });
    }

    if (text === "Цены на топливо ⛽️") {
        return ctx.reply(`⛽️ <b>Средние цены:</b>\n\n95-й: ~56.4₽\n92-й: ~51.2₽`, { parse_mode: "HTML" });
    }

    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        const kb = new InlineKeyboard();
        ["Москва", "Санкт-Петербург", "Казань", "Новосибирск", "Екатеринбург", "Нижний Новгород"].forEach(c => kb.text(c, `reg_${c}`).row());
        return ctx.reply("🏙 Выберите ваш город:", { reply_markup: kb });
    }
});

bot.on("callback_query:data", async (ctx) => {
    if (ctx.callbackQuery.data.startsWith("reg_")) {
        const city = ctx.callbackQuery.data.split("_")[1];
        await User.findOneAndUpdate({ userId: ctx.from.id }, {
            userId: ctx.from.id, username: ctx.from.username, city, tariff: ctx.session.tariff, isAllowed: (ctx.from.id === ADMIN_ID)
        }, { upsert: true });
        await ctx.editMessageText(`✅ Регистрация завершена! Нажмите /start`);
    }
});

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.startsWith('/api/points')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const city = url.searchParams.get('city');
        const filter = (city && city !== "undefined" && city !== "null") ? { city } : {};
        const events = await Event.find(filter);
        res.end(JSON.stringify(events));
    } else res.end(JSON.stringify({ status: "ok" }));
});

bot.start();
server.listen(process.env.PORT || 8080);