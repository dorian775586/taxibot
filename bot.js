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
mongoose.connect(mongoUri)
    .then(() => console.log("[DB] Успешное подключение к MongoDB"))
    .catch(err => console.error("[DB] Ошибка подключения:", err));

const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: String, 
    tariff: String, 
    city: String,
    isAllowed: { type: Boolean, default: false },
    expiryDate: Date, 
    username: String
});
const User = mongoose.model("User", userSchema);

const fuelSchema = new mongoose.Schema({
    city: { type: String, unique: true },
    ai92: String, ai95: String, dt: String, gas: String, lastUpdate: Date
});
const Fuel = mongoose.model("Fuel", fuelSchema);

bot.use(session({ initial: () => ({ step: "idle", tariff: null }) }));

// --- 🌐 ЛОГИКА ПАРСЕРА ---

async function fetchFuelPrices(cityName) {
    try {
        const cityTranslit = {
            "Москва": "moskva", "Санкт-Петербург": "sankt-peterburg", 
            "Новосибирск": "novosibirsk", "Екатеринбург": "ekaterinburg", 
            "Казань": "kazan", "Челябинск": "chelyabinsk"
        };
        const slug = cityTranslit[cityName] || "moskva";
        const { data } = await axios.get(`https://fuelprices.ru/${slug}`, { timeout: 5000 });
        const $ = cheerio.load(data);
        const p = [];
        $(".price_table tr td").each((i, el) => p.push($(el).text().trim()));

        if (p.length > 0) {
            const data = {
                city: cityName,
                ai92: p[1] || "—", ai95: p[3] || "—", dt: p[5] || "—", gas: p[7] || "—",
                lastUpdate: new Date()
            };
            await Fuel.findOneAndUpdate({ city: cityName }, data, { upsert: true });
            return data;
        }
    } catch (e) {
        console.error(`[PARSER ERROR] ${cityName}:`, e.message);
        return null;
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
    const menu = new Keyboard()
        .text("Открыть карту 🔥")
        .row()
        .text("Цены на топливо ⛽️")
        .text("Мой профиль 👤")
        .resized();
    
    if (ctx.from.id === ADMIN_ID) menu.row().text("Список водителей 📋");

    let status = user.isAllowed ? "🟢 Доступ открыт" : "🔴 Доступ закрыт";
    await ctx.reply(`🏠 **Главное меню**\nСтатус: ${status}`, { reply_markup: menu, parse_mode: "Markdown" });
}

// --- 🚀 ОБРАБОТКА ---

bot.command("start", async (ctx) => {
    let user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        ctx.session.step = "wait_tariff";
        const kb = new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime();
        await ctx.reply("🚕 Добро пожаловать! Выберите ваш тариф:", { reply_markup: kb });
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
            userId: ctx.from.id,
            username: ctx.from.username,
            tariff: ctx.session.tariff,
            city: city,
            name: `Водитель #${count + 1}`,
            isAllowed: false
        });
        await user.save();
        ctx.session.step = "idle";
        await ctx.editMessageText(`✅ Регистрация завершена!\n👤 Ваш ID: ${user.name}\n🏙 Город: ${city}\n\nОжидайте активации доступа администратором.`);
        await bot.api.sendMessage(ADMIN_ID, `🔔 Новая заявка: ${user.name} (${city}, ${user.tariff})`);
    }

    if (data.startsWith("manage_")) {
        const tid = data.split("_")[1];
        const u = await User.findOne({ userId: tid });
        const kb = new InlineKeyboard()
            .text("✅ Доступ (31д)", `allow_${tid}`)
            .text("🚫 Блок", `block_${tid}`).row()
            .text("⬅️ Назад", "back_to_list");
        await ctx.editMessageText(`👤 ${u.name}\n🏙 Город: ${u.city}\n💰 Тариф: ${u.tariff}\n🔓 Доступ: ${u.isAllowed ? "Да" : "Нет"}`, { reply_markup: kb });
    }

    if (data === "back_to_list") {
        const users = await User.find();
        const kb = new InlineKeyboard();
        users.forEach(u => { kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row(); });
        await ctx.editMessageText("👥 Список водителей:", { reply_markup: kb });
    }

    if (data.startsWith("allow_") || data.startsWith("block_")) {
        const [act, tid] = data.split("_");
        const ok = act === "allow";
        const exp = ok ? dayjs().add(31, 'day').toDate() : null;
        await User.findOneAndUpdate({ userId: tid }, { isAllowed: ok, expiryDate: exp });
        await bot.api.sendMessage(tid, ok ? "🎉 Доступ к карте открыт!" : "❌ Доступ закрыт.");
        await ctx.answerCallbackQuery("Готово");
        await ctx.editMessageText("✅ Статус обновлен.");
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
            await ctx.reply("⏳ Обновляю данные с биржи...");
            f = await fetchFuelPrices(u.city);
        }

        if (!f) return ctx.reply("❌ Данные временно недоступны.");
        return ctx.reply(`⛽️ **Средние цены в г. ${u.city}:**\n\n🔹 АИ-92: ${f.ai92} р.\n🔸 АИ-95: ${f.ai95} р.\n🚜 ДТ: ${f.dt} р.\n💨 Газ: ${f.gas} р.\n\n_🕒 Обновлено: ${dayjs(f.lastUpdate).format("DD.MM HH:mm")}_`, { parse_mode: "Markdown" });
    }

    if (text === "Открыть карту 🔥") {
        const u = await User.findOne({ userId });
        if (u?.isAllowed) return ctx.reply("📍 Карта готова!", { reply_markup: new InlineKeyboard().webApp("Запустить", webAppUrl) });
        return ctx.reply("🚫 Доступ закрыт.");
    }

    if (text === "Мой профиль 👤") {
        const u = await User.findOne({ userId });
        if (!u) return;
        return ctx.reply(`👤 **Ваш профиль:**\n🆔 ID: ${u.name}\n📍 Город: ${u.city}\n🚖 Тариф: ${u.tariff}\n⏳ Статус: ${u.isAllowed ? "Активен" : "На проверке"}`, { parse_mode: "Markdown" });
    }

    if (text === "Список водителей 📋" && userId === ADMIN_ID) {
        const users = await User.find();
        const kb = new InlineKeyboard();
        users.forEach(u => { kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row(); });
        return ctx.reply("👥 Список водителей:", { reply_markup: kb });
    }

    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        await ctx.reply("🏙 Отлично! Теперь выберите ваш город:", { reply_markup: getCitiesKeyboard() });
    }
});

bot.catch((err) => console.error("[ERROR]", err));

bot.start({ drop_pending_updates: true });

http.createServer((req, res) => { res.writeHead(200); res.end("1"); }).listen(process.env.PORT || 8080);