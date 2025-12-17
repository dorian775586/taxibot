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

// --- 🚀 УСКОРЕННЫЙ ПАРСЕР (Параллельный запрос) ---
async function updateAllCities() {
    const CITIES_LIST = [
        { name: "Москва", slug: "msk" }, { name: "Санкт-Петербург", slug: "spb" },
        { name: "Казань", slug: "kzn" }, { name: "Новосибирск", slug: "nsk" },
        { name: "Екатеринбург", slug: "ekb" }, { name: "Нижний Новгород", slug: "nnv" },
        { name: "Челябинск", slug: "che" }
    ];

    const nowUnix = Math.floor(Date.now() / 1000);

    // Запускаем все запросы одновременно
    const promises = CITIES_LIST.map(async (city) => {
        try {
            const url = `https://kudago.com/public-api/v1.4/events/?location=${city.slug}&fields=title,place,dates&page_size=35&expand=place&actual_since=${nowUnix}`;
            const { data } = await axios.get(url, { timeout: 10000 });
            
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
                return events.length;
            }
            return 0;
        } catch (e) {
            console.error(`❌ Ошибка города ${city.name}:`, e.message);
            return 0;
        }
    });

    const results = await Promise.all(promises);
    return results.reduce((a, b) => a + b, 0);
}

// --- 🤖 ЛОГИКА ОБРАБОТКИ ---
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
        const menu = new Keyboard()
            .text("Открыть карту 🔥").row()
            .text("События сегодня 🎭").text("Цены на топливо ⛽️").row()
            .text("Аналитика 📊").text("Мой профиль 👤").resized();
        
        if (userId === ADMIN_ID) menu.row().text("Список водителей 📋").text("Обновить карту 🔄");
        return ctx.reply("🏠 Главное меню", { reply_markup: menu });
    }

    // Удаление лишних записей
    if (text === "/clean_database" && userId === ADMIN_ID) {
        await User.deleteMany({ userId: { $ne: ADMIN_ID } });
        return ctx.reply("🧹 База очищена. Остался только ты.");
    }

    if (text === "Обновить карту 🔄" && userId === ADMIN_ID) {
        const loadingMsg = await ctx.reply("📡 Синхронизация с серверами событий... Подождите 5-10 сек.");
        const count = await updateAllCities();
        return ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, `✅ Готово! На карту добавлено ${count} активных точек.`);
    }

    if (text === "Список водителей 📋" && userId === ADMIN_ID) {
        const drivers = await User.find().sort({ regDate: -1 }).lean();
        if (!drivers.length) return ctx.reply("📭 Водителей нет.");

        let msg = `👥 **Водителей в базе: ${drivers.length}**\n\n`;
        drivers.forEach((d, i) => {
            const date = dayjs(d.regDate).format("DD.MM HH:mm");
            const userLink = d.username ? `@${d.username}` : `ID:${d.userId}`;
            const line = `${i+1}. ${date} | ${d.city || '??'} | ${userLink}\n`;
            if ((msg + line).length > 4000) {
                ctx.reply(msg, { parse_mode: "Markdown" });
                msg = "";
            }
            msg += line;
        });
        return ctx.reply(msg, { parse_mode: "Markdown" });
    }

    if (text === "Открыть карту 🔥") {
        if (!user?.isAllowed && userId !== ADMIN_ID) return ctx.reply("🚫 Доступ не подтвержден. Напишите @bogat777");
        const url = `${webAppUrl}?city=${encodeURIComponent(user?.city || "Москва")}`;
        return ctx.reply("📍 Карта горячих точек открыта:", { 
            reply_markup: new InlineKeyboard().webApp("Открыть карту", url) 
        });
    }

    if (text === "Аналитика 📊") {
        const [uCount, eCount] = await Promise.all([User.countDocuments(), Event.countDocuments()]);
        return ctx.reply(`📊 **Статистика:**\n• Водителей: ${uCount}\n• Точек на карте: ${eCount}`);
    }

    if (text === "Мой профиль 👤") {
        const status = (user?.isAllowed || userId === ADMIN_ID) ? "✅ Одобрен" : "⏳ На проверке";
        return ctx.reply(`👤 **Профиль:**\n\n🆔 ID: \`${userId}\`\n🏙 Город: ${user?.city || "—"}\n🚕 Тариф: ${user?.tariff || "—"}\n🚦 Доступ: ${status}`, { parse_mode: "Markdown" });
    }

    if (text === "Цены на топливо ⛽️") {
        return ctx.reply(`⛽️ **Средние цены (РФ):**\n\n95-й: ~56.4₽\n92-й: ~51.2₽\nДизель: ~65.1₽`);
    }

    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        const kb = new InlineKeyboard();
        ["Москва", "Санкт-Петербург", "Казань", "Новосибирск", "Екатеринбург", "Нижний Новгород"].forEach(c => kb.text(c, `reg_${c}`).row());
        return ctx.reply("🏙 В каком городе вы работаете?", { reply_markup: kb });
    }
});

bot.on("callback_query:data", async (ctx) => {
    if (ctx.callbackQuery.data.startsWith("reg_")) {
        const city = ctx.callbackQuery.data.split("_")[1];
        await User.findOneAndUpdate({ userId: ctx.from.id }, {
            userId: ctx.from.id, username: ctx.from.username, city, tariff: ctx.session.tariff, isAllowed: (ctx.from.id === ADMIN_ID)
        }, { upsert: true });
        await ctx.editMessageText(`✅ Данные сохранены! Теперь вы можете пользоваться ботом.\n📍 Город: ${city}\n🚕 Тариф: ${ctx.session.tariff}\n\nНажмите /start для обновления меню.`);
    }
});

// --- API СЕРВЕР ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.startsWith('/api/points')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const city = url.searchParams.get('city');
        const filter = (city && city !== "undefined" && city !== "null") ? { city } : {};
        const events = await Event.find(filter);
        res.end(JSON.stringify(events));
    } else res.end(JSON.stringify({ status: "running" }));
});

bot.start();
server.listen(process.env.PORT || 8080);