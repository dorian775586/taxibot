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
mongoose.connect(mongoUri).then(() => console.log("✅ База подключена"));

const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: String, 
    tariff: String, 
    city: String,
    isAllowed: { type: Boolean, default: false },
    expiryDate: { type: Date, default: null }, 
    username: String,
    regDate: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

const fuelSchema = new mongoose.Schema({
    city: { type: String, unique: true },
    ai92: String, ai95: String, dt: String, gas: String, lastUpdate: Date
});
const Fuel = mongoose.model("Fuel", fuelSchema);

const Event = mongoose.model("Event", new mongoose.Schema({
    city: String, title: String, address: String, lat: Number, lng: Number, expireAt: Date
}));

bot.use(session({ initial: () => ({ step: "idle", tariff: null }) }));

// --- 🌐 ПАРСЕР ТОПЛИВА ---
async function fetchFuelPrices(cityName) {
    try {
        const cityTranslit = {
            "Москва": "moskva", "Санкт-Петербург": "sankt-peterburg", 
            "Новосибирск": "novosibirsk", "Екатеринбург": "ekaterinburg", 
            "Казань": "kazan", "Челябинск": "chelyabinsk"
        };
        const slug = cityTranslit[cityName];
        if (!slug) return null;
        const { data } = await axios.get(`https://fuelprices.ru/${slug}`, { timeout: 8000 });
        const $ = cheerio.load(data);
        const p = [];
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
    } catch (e) { return null; }
}

// --- 🚀 ПАРСЕР КАРТЫ (БЫСТРЫЙ) ---
async function updateAllCities() {
    const CITIES = ["msk", "spb", "kzn", "nsk", "ekb", "nnv", "che"];
    const nowUnix = Math.floor(Date.now() / 1000);
    let total = 0;
    for (const slug of CITIES) {
        try {
            const url = `https://kudago.com/public-api/v1.4/events/?location=${slug}&fields=title,place,dates&page_size=35&expand=place&actual_since=${nowUnix}`;
            const { data } = await axios.get(url);
            const events = data.results.filter(i => i.place && i.place.coords).map(i => ({
                city: i.place.location === 'msk' ? 'Москва' : (i.place.location === 'spb' ? 'Санкт-Петербург' : i.place.location),
                title: i.title, address: i.place.address, lat: i.place.coords.lat, lng: i.place.coords.lon,
                expireAt: dayjs().add(5, 'hour').toDate()
            }));
            if (events.length > 0) { await Event.insertMany(events); total += events.length; }
        } catch (e) {}
    }
    return total;
}

// --- 🛠️ КЛАВИАТУРЫ ---
function getCitiesKeyboard() {
    const kb = new InlineKeyboard();
    ["Москва", "Санкт-Петербург", "Новосибирск", "Екатеринбург", "Казань", "Челябинск"].forEach((c, i) => {
        kb.text(c, `regcity_${c}`);
        if ((i + 1) % 2 === 0) kb.row();
    });
    return kb;
}

// --- 🤖 ЛОГИКА ---
bot.command("start", async (ctx) => {
    let user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        ctx.session.step = "wait_tariff";
        return ctx.reply("🚕 Добро пожаловать! Выберите тариф:", { 
            reply_markup: new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime() 
        });
    }
    const menu = new Keyboard()
        .text("Открыть карту 🔥").row()
        .text("Цены на топливо ⛽️").text("Мой профиль 👤").row()
        .text("Аналитика 📊").resized();
    
    if (ctx.from.id === ADMIN_ID) menu.row().text("Список водителей 📋").text("Обновить карту 🔄");
    
    const status = (user.isAllowed && user.expiryDate > new Date()) ? "🟢 Активен" : "🔴 Доступ закрыт";
    await ctx.reply(`🏠 **Главное меню**\nСтатус: ${status}`, { reply_markup: menu, parse_mode: "Markdown" });
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith("regcity_")) {
        const city = data.split("_")[1];
        const count = await User.countDocuments();
        const user = new User({
            userId: ctx.from.id, username: ctx.from.username,
            tariff: ctx.session.tariff, city: city,
            name: `Водитель #${count + 1}`, isAllowed: false
        });
        await user.save();
        ctx.session.step = "idle";
        await ctx.editMessageText(`✅ Заявка отправлена!\nID: ${user.name}\nГород: ${city}\n\nОжидайте активации админом.`);
        await bot.api.sendMessage(ADMIN_ID, `🔔 Новая заявка: ${user.name} (${city})`);
    }

    if (ctx.from.id !== ADMIN_ID) return;

    if (data.startsWith("manage_")) {
        const tid = data.split("_")[1];
        const u = await User.findOne({ userId: tid });
        const kb = new InlineKeyboard()
            .text("✅ Доступ (31д)", `allow_${tid}`)
            .text("🚫 Блок", `block_${tid}`).row()
            .text("🗑 Удалить", `delete_${tid}`).row()
            .text("⬅️ Назад", "back_to_list");
        await ctx.editMessageText(`👤 ${u.name}\nТГ: @${u.username || '—'}\nГород: ${u.city}\nДоступ: ${u.isAllowed ? "Да" : "Нет"}`, { reply_markup: kb });
    }

    if (data === "back_to_list") {
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row());
        await ctx.editMessageText("👥 Список водителей:", { reply_markup: kb });
    }

    if (data.startsWith("allow_") || data.startsWith("block_")) {
        const [act, tid] = data.split("_");
        const ok = act === "allow";
        await User.findOneAndUpdate({ userId: tid }, { isAllowed: ok, expiryDate: ok ? dayjs().add(31, 'day').toDate() : null });
        ctx.answerCallbackQuery("Выполнено");
        await bot.api.sendMessage(tid, ok ? "✅ Доступ одобрен на 31 день!" : "❌ Доступ ограничен.");
        return ctx.editMessageText("✅ Статус обновлен.");
    }

    if (data.startsWith("delete_")) {
        await User.findOneAndDelete({ userId: data.split("_")[1] });
        ctx.answerCallbackQuery("Удален");
        await ctx.editMessageText("🗑 Удалено.");
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    if (text === "Открыть карту 🔥") {
        if (userId === ADMIN_ID || (user?.isAllowed && user.expiryDate > new Date())) {
            return ctx.reply("📍 Карта готова:", { reply_markup: new InlineKeyboard().webApp("Запустить", `${webAppUrl}?city=${user?.city || 'Москва'}`) });
        }
        return ctx.reply("🚫 Нет доступа.");
    }

    if (text === "Цены на топливо ⛽️") {
        if (!user) return;
        let f = await Fuel.findOne({ city: user.city });
        if (!f) f = await fetchFuelPrices(user.city);
        if (!f) return ctx.reply("❌ Нет данных.");
        return ctx.reply(`⛽️ **Цены ${user.city}:**\n92: ${f.ai92}\n95: ${f.ai95}\nДТ: ${f.dt}\nГаз: ${f.gas}`, { parse_mode: "Markdown" });
    }

    if (text === "Мой профиль 👤") {
        if (!user) return;
        const exp = user.expiryDate ? dayjs(user.expiryDate).format("DD.MM.YYYY") : "Нет";
        return ctx.reply(`👤 **Профиль:**\nID: ${user.name}\nГород: ${user.city}\nДоступ до: ${exp}`, { parse_mode: "Markdown" });
    }

    if (text === "Аналитика 📊") {
        const uCount = await User.countDocuments();
        const eCount = await Event.countDocuments();
        return ctx.reply(`📊 **Статистика:**\nВодителей: ${uCount}\nТочек на карте: ${eCount}`);
    }

    if (text === "Список водителей 📋" && userId === ADMIN_ID) {
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row());
        return ctx.reply("👥 Список водителей:", { reply_markup: kb });
    }

    if (text === "Обновить карту 🔄" && userId === ADMIN_ID) {
        await ctx.reply("📡 Обновляю точки...");
        await Event.deleteMany({});
        const count = await updateAllCities();
        return ctx.reply(`✅ Карта обновлена! Точек: ${count}`);
    }

    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        return ctx.reply("🏙 Выберите город:", { reply_markup: getCitiesKeyboard() });
    }
});

bot.catch((err) => console.error(err));
bot.start();
http.createServer((req, res) => res.end("OK")).listen(process.env.PORT || 8080);