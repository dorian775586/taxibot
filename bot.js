const { Bot, Keyboard, InlineKeyboard, session, GrammyError, HttpError } = require("grammy");
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
mongoose.connect(mongoUri).then(() => console.log("[DB] Connected"));

const User = mongoose.model("User", new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: String, tariff: String, city: String,
    isAllowed: { type: Boolean, default: false },
    expiryDate: Date, username: String
}));

const Fuel = mongoose.model("Fuel", new mongoose.Schema({
    city: { type: String, unique: true },
    ai92: String, ai95: String, dt: String, gas: String, lastUpdate: Date
}));

bot.use(session({ initial: () => ({ step: "idle", tariff: null }) }));

// --- 🌐 НОВЫЙ ПАРСЕР (БОЛЕЕ СТАБИЛЬНЫЙ) ---

async function fetchFuelPrices(cityName) {
    try {
        const cityTranslit = {
            "Москва": "moskva", "Санкт-Петербург": "sankt-peterburg", 
            "Новосибирск": "novosibirsk", "Екатеринбург": "ekaterinburg", 
            "Казань": "kazan", "Челябинск": "chelyabinsk"
        };
        const slug = cityTranslit[cityName];
        if (!slug) return null;

        // Используем зеркало или альтернативный путь, добавляя заголовки браузера
        const { data } = await axios.get(`https://fuelprices.ru/${slug}`, { 
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
            }
        });
        
        const $ = cheerio.load(data);
        const p = [];
        // На этом сайте цены лежат в таблице price_table
        $(".price_table tr td").each((i, el) => p.push($(el).text().trim()));

        if (p.length > 5) {
            const fuelData = {
                city: cityName,
                ai92: p[1] || "—", ai95: p[3] || "—", dt: p[5] || "—", gas: p[7] || "—",
                lastUpdate: new Date()
            };
            await Fuel.findOneAndUpdate({ city: cityName }, fuelData, { upsert: true });
            return fuelData;
        }
        return null;
    } catch (e) {
        console.error(`[PARSER ERROR] ${cityName}: ${e.message}`);
        // Если сайт всё еще выдает 404/403, вернем хотя бы старые данные из базы, если они там есть
        return await Fuel.findOne({ city: cityName });
    }
}

// --- 🛠️ КЛАВИАТУРЫ ---
const popularCities = ["Москва", "Санкт-Петербург", "Новосибирск", "Екатеринбург", "Казань", "Челябинск"];

function getCitiesKeyboard() {
    const kb = new InlineKeyboard();
    popularCities.forEach((city, i) => {
        kb.text(city, `regcity_${city}`);
        if ((i + 1) % 2 === 0) kb.row();
    });
    return kb;
}

async function showMainMenu(ctx, user) {
    const menu = new Keyboard().text("Открыть карту 🔥").row().text("Цены на топливо ⛽️").text("Мой профиль 👤").resized();
    if (ctx.from.id === ADMIN_ID) menu.row().text("Список водителей 📋");
    const status = user.isAllowed ? "🟢 Доступ открыт" : "🔴 Доступ закрыт";
    await ctx.reply(`🏠 **Главное меню**\nСтатус: ${status}`, { reply_markup: menu, parse_mode: "Markdown" });
}

// --- 🚀 ОБРАБОТКА ---

bot.command("start", async (ctx) => {
    let user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        ctx.session.step = "wait_tariff";
        const kb = new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime();
        await ctx.reply("🚕 Добро пожаловать! Выберите тариф:", { reply_markup: kb });
    } else {
        await showMainMenu(ctx, user);
    }
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith("regcity_")) {
        const city = data.split("_")[1];
        const count = await User.countDocuments();
        const user = new User({
            userId: ctx.from.id, username: ctx.from.username,
            tariff: ctx.session.tariff, city: city,
            name: `Водитель #${count + 1}`, isAllowed: (ctx.from.id === ADMIN_ID)
        });
        await user.save();
        ctx.session.step = "idle";
        await ctx.editMessageText(`✅ Готово!\nВаш ID: ${user.name}\nГород: ${city}`);
        await showMainMenu(ctx, user);
    }

    if (data.startsWith("manage_")) {
        const tid = data.split("_")[1];
        const u = await User.findOne({ userId: tid });
        const kb = new InlineKeyboard().text("✅ Доступ", `allow_${tid}`).text("🚫 Блок", `block_${tid}`).row().text("🗑 Удалить", `delete_${tid}`).row().text("⬅️ Назад", "back_to_list");
        await ctx.editMessageText(`👤 ${u.name}\n🏙 ${u.city}\n🔓 Доступ: ${u.isAllowed ? "Да" : "Нет"}`, { reply_markup: kb });
    }

    if (data === "back_to_list") {
        const users = await User.find();
        const kb = new InlineKeyboard();
        users.forEach(u => { kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row(); });
        await ctx.editMessageText("👥 Список водителей:", { reply_markup: kb });
    }

    if (data.startsWith("allow_") || data.startsWith("block_")) {
        const [act, tid] = data.split("_");
        await User.findOneAndUpdate({ userId: tid }, { isAllowed: act === "allow" });
        await ctx.editMessageText("✅ Обновлено.");
    }

    if (data.startsWith("delete_")) {
        await User.findOneAndDelete({ userId: data.split("_")[1] });
        await ctx.editMessageText("🗑 Удален. Напишите /start для новой регистрации.");
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;

    if (text === "Цены на топливо ⛽️") {
        const u = await User.findOne({ userId });
        if (!u) return;
        let f = await Fuel.findOne({ city: u.city });
        
        // Если данных нет или они старее 12 часов - обновляем
        if (!f || dayjs().diff(dayjs(f.lastUpdate), 'hour') > 12) {
            await ctx.reply("⏳ Запрашиваю актуальные цены...");
            f = await fetchFuelPrices(u.city);
        }

        if (!f) return ctx.reply("❌ Не удалось получить данные. Попробуйте позже.");
        return ctx.reply(`⛽️ **Цены в г. ${u.city}:**\n\n🔹 АИ-92: ${f.ai92} р.\n🔸 АИ-95: ${f.ai95} р.\n🚜 ДТ: ${f.dt} р.\n💨 Газ: ${f.gas} р.\n\n_🕒 Обновлено: ${dayjs(f.lastUpdate).format("DD.MM HH:mm")}_`, { parse_mode: "Markdown" });
    }

    if (text === "Открыть карту 🔥") {
        const u = await User.findOne({ userId });
        if (u?.isAllowed) return ctx.reply("📍 Карта:", { reply_markup: new InlineKeyboard().webApp("Запустить", webAppUrl) });
        return ctx.reply("🚫 Нет доступа.");
    }

    if (text === "Список водителей 📋" && userId === ADMIN_ID) {
        const users = await User.find();
        const kb = new InlineKeyboard();
        users.forEach(u => { kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row(); });
        return ctx.reply("👥 Список:", { reply_markup: kb });
    }

    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        await ctx.reply("🏙 Выберите город:", { reply_markup: getCitiesKeyboard() });
    }
});

bot.start({ drop_pending_updates: true });
http.createServer((req, res) => { res.end("1"); }).listen(process.env.PORT || 8080);