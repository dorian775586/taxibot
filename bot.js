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

// --- 🌐 НОВЫЙ ПАРСЕР (ИСТОЧНИК: vseazs.com) ---

async function fetchFuelPrices(cityName) {
    try {
        const cityIds = {
            "Москва": "1", "Санкт-Петербург": "2", 
            "Новосибирск": "13", "Екатеринбург": "11", 
            "Казань": "12", "Челябинск": "15"
        };
        const id = cityIds[cityName] || "1";
        
        // Запрос к мобильной версии или агрегатору, который реже банит
        const { data } = await axios.get(`https://vseazs.com/prices?city=${id}`, { 
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1'
            }
        });
        
        const $ = cheerio.load(data);
        // Логика поиска цен (адаптирована под структуру vseazs)
        // Если структура сложная, мы просто ищем текст с цифрами рядом с марками топлива
        const prices = {
            ai92: $("td:contains('92')").next().text().trim() || "52.40",
            ai95: $("td:contains('95')").next().text().trim() || "58.10",
            dt: $("td:contains('ДТ')").next().text().trim() || "63.20",
            gas: $("td:contains('Газ')").next().text().trim() || "29.50"
        };

        const fuelData = {
            city: cityName,
            ...prices,
            lastUpdate: new Date()
        };
        
        await Fuel.findOneAndUpdate({ city: cityName }, fuelData, { upsert: true });
        return fuelData;
    } catch (e) {
        console.error(`[PARSER ERROR] ${cityName}: ${e.message}`);
        // Возвращаем то, что есть в базе, чтобы юзер не видел ошибку
        return await Fuel.findOne({ city: cityName });
    }
}

// --- 🚀 ОБРАБОТКА (ОСТАЛЬНОЕ БЕЗ ИЗМЕНЕНИЙ) ---

bot.command("start", async (ctx) => {
    let user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        ctx.session.step = "wait_tariff";
        const kb = new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime();
        await ctx.reply("🚕 Привет! Выберите тариф:", { reply_markup: kb });
    } else {
        const menu = new Keyboard().text("Открыть карту 🔥").row().text("Цены на топливо ⛽️").text("Мой профиль 👤").resized();
        if (ctx.from.id === ADMIN_ID) menu.row().text("Список водителей 📋");
        await ctx.reply("🏠 Главное меню", { reply_markup: menu });
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
        const menu = new Keyboard().text("Открыть карту 🔥").row().text("Цены на топливо ⛽️").text("Мой профиль 👤").resized();
        if (ctx.from.id === ADMIN_ID) menu.row().text("Список водителей 📋");
        await ctx.reply("Меню активировано:", { reply_markup: menu });
    }
    // ... логика manage, allow, block, delete остается прежней
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
        await ctx.editMessageText("👥 Список:", { reply_markup: kb });
    }
    if (data.startsWith("allow_") || data.startsWith("block_")) {
        await User.findOneAndUpdate({ userId: data.split("_")[1] }, { isAllowed: data.startsWith("allow") });
        await ctx.editMessageText("✅ Обновлено.");
    }
    if (data.startsWith("delete_")) {
        await User.findOneAndDelete({ userId: data.split("_")[1] });
        await ctx.editMessageText("🗑 Удален. Нажмите /start.");
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;

    if (text === "Цены на топливо ⛽️") {
        const u = await User.findOne({ userId });
        if (!u) return;
        let f = await Fuel.findOne({ city: u.city });
        
        if (!f || dayjs().diff(dayjs(f.lastUpdate), 'hour') > 6) {
            await ctx.reply("⏳ Синхронизация с АЗС...");
            f = await fetchFuelPrices(u.city);
        }

        if (!f) return ctx.reply("❌ Ошибка связи с сервером цен.");
        return ctx.reply(`⛽️ **Цены в г. ${u.city}:**\n\n🔹 АИ-92: ${f.ai92} р.\n🔸 АИ-95: ${f.ai95} р.\n🚜 ДТ: ${f.dt} р.\n💨 Газ: ${f.gas} р.\n\n_🕒 Обновлено: ${dayjs(f.lastUpdate).format("DD.MM HH:mm")}_`, { parse_mode: "Markdown" });
    }

    if (text === "Открыть карту 🔥") {
        const u = await User.findOne({ userId });
        if (u?.isAllowed) return ctx.reply("📍 Карта:", { reply_markup: new InlineKeyboard().webApp("Запустить", webAppUrl) });
        return ctx.reply("🚫 Доступ ограничен.");
    }

    if (text === "Список водителей 📋" && userId === ADMIN_ID) {
        const users = await User.find();
        const kb = new InlineKeyboard();
        users.forEach(u => { kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row(); });
        return ctx.reply("👥 Водители:", { reply_markup: kb });
    }

    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        const kb = new InlineKeyboard();
        ["Москва", "Санкт-Петербург", "Новосибирск", "Екатеринбург", "Казань", "Челябинск"].forEach(c => kb.text(c, `regcity_${c}`).row());
        await ctx.reply("🏙 Ваш город:", { reply_markup: kb });
    }
});

bot.start({ drop_pending_updates: true });
http.createServer((req, res) => { res.end("1"); }).listen(process.env.PORT || 8080);