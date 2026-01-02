const { Bot, Keyboard, InlineKeyboard, session, GrammyError, HttpError } = require("grammy");
const mongoose = require("mongoose");
const http = require("http");
const dayjs = require("dayjs");
const axios = require("axios");
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const token = "7973955726:AAFpMltfoqwO902Q1su5j6HWipPxEJYM3-o";
const webAppUrl = "https://hotmaptaxi-git-main-dorians-projects-14978635.vercel.app";
const mongoUri = "mongodb+srv://user775586:user775586@cluster0.36spuej.mongodb.net/?appName=Cluster0"; 

const ADMINS = [623203896, 7469074713];

const bot = new Bot(token);

mongoose.connect(mongoUri).then(() => console.log("✅ База подключена"));

// --- СХЕМЫ ДАННЫХ ---
const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: { type: String, default: "Водитель" }, 
    tariff: String, city: String,
    isAllowed: { type: Boolean, default: false },
    expiryDate: { type: Date, default: null }, 
    username: String, displayName: String, 
    regDate: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

const Fuel = mongoose.model("Fuel", new mongoose.Schema({
    city: { type: String, unique: true },
    prices: { type: String, default: "92: — | 95: — | ДТ: — | Газ: —" }
}));

const Event = mongoose.model("Event", new mongoose.Schema({
    city: String, title: String, address: String, lat: Number, lng: Number, expireAt: Date
}));

const Taxi = mongoose.model("Taxi", new mongoose.Schema({
    city: String, lat: Number, lng: Number, expireAt: Date
}));

// Инициализация сессии (Добавлены selectedPrice для тарифов)
bot.use(session({ 
    initial: () => ({ 
        step: "idle", 
        tariff: null, 
        replyToUser: null, 
        editingCity: null,
        tempOrderData: null, 
        currentService: null,
        selectedPrice: 0 
    }) 
}));

// --- 🚀 ГЕНЕРАЦИЯ ТАКСИ (ТВОЙ КОД) ---
async function generateTaxisInDatabase(userLat, userLng, cityName) {
    await Taxi.deleteMany({ expireAt: { $lt: new Date() } });
    const existingCount = await Taxi.countDocuments({
        lat: { $gt: userLat - 0.1, $lt: userLat + 0.1 },
        lng: { $gt: userLng - 0.1, $lt: userLng + 0.1 }
    });
    if (existingCount >= 15) return []; 
    const newTaxis = [];
    const count = 20; 
    for (let i = 0; i < count; i++) {
        let lat = userLat + (Math.random() - 0.5) * 0.15; 
        let lng = userLng + (Math.random() - 0.5) * 0.15;
        newTaxis.push({
            city: cityName, lat: lat, lng: lng,
            expireAt: dayjs().add(20, 'minute').toDate()
        });
    }
    if (newTaxis.length) await Taxi.insertMany(newTaxis);
    return newTaxis;
}

// --- 🚀 ОБНОВЛЕНИЕ ЗОН (ТВОЙ КОД) ---
async function updateAllCities() {
    const CITIES_LIST = [
        { slug: "msk", name: "Москва" }, { slug: "spb", name: "Санкт-Петербург" },
        { slug: "nsk", name: "Новосибирск" }, { slug: "ekb", name: "Екатеринбург" },
        { slug: "kzn", name: "Казань" }, { slug: "che", name: "Челябинск" }
    ];
    await Event.deleteMany({}); 
    let total = 0;
    for (const cityObj of CITIES_LIST) {
        try {
            const url = `https://kudago.com/public-api/v1.4/events/?location=${cityObj.slug}&fields=place,dates,title&page_size=50&expand=place&actual_since=${Math.floor(Date.now()/1000)}`;
            const { data } = await axios.get(url);
            const events = data.results.filter(i => i.place && i.place.coords).map(i => ({
                city: cityObj.name, title: i.title, address: i.place.address,
                lat: i.place.coords.lat, lng: i.place.coords.lon,
                expireAt: dayjs().add(2, 'hour').toDate()
            }));
            if (events.length > 0) { await Event.insertMany(events); total += events.length; }
        } catch (e) { console.log(`Ошибка парсинга ${cityObj.name}:`, e.message); }
    }
    return total;
}
setInterval(updateAllCities, 1800000); 

// --- 🛠️ КЛАВИАТУРЫ ---
function getMainKeyboard(userId) {
    const kb = new Keyboard()
        .text("Открыть карту 🔥").text("Буст аккаунта ⚡️").row()
        .text("Цены на топливо ⛽️").text("Мой профиль 👤").row()
        .text("Платные услуги 💎").row()
        .text("Техподдержка 🆘");
    if (ADMINS.includes(userId)) {
        kb.row().text("Аналитика 📊").text("Список водителей 📋").row().text("Обновить карту 🔄");
    }
    return kb.resized();
}

function getCitiesKeyboard() {
    const kb = new InlineKeyboard();
    ["Москва", "Санкт-Петербург", "Новосибирск", "Екатеринбург", "Казань", "Челябинск"].forEach((c, i) => {
        kb.text(c, `regcity_${c}`);
        if ((i + 1) % 2 === 0) kb.row();
    });
    return kb;
}

function getPaidServicesKeyboard() {
    return new InlineKeyboard()
        .text("🚀 Повышение приоритета", "service_priority").row()
        .text("🔍 Глубокий анализ аккаунта", "service_analysis").row()
        .text("💎 Индивидуальный расчет", "service_custom").row();
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
    const status = (user.isAllowed && user.expiryDate > new Date()) ? "🟢 Активен" : "🔴 Доступ закрыт";
    await ctx.reply(`🏠 **Главное меню**\nСтатус: ${status}`, { reply_markup: getMainKeyboard(ctx.from.id), parse_mode: "Markdown" });
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    // Услуга: Приоритет (с выбором цен)
    if (data === "service_priority") {
        ctx.session.currentService = "ПОВЫШЕНИЕ ПРИОРИТЕТА";
        const kb = new InlineKeyboard()
            .text("🔹 Стандарт (2 000 ₽)", "set_price_2000").row()
            .text("🔥 Срочный (5 000 ₽)", "set_price_5000").row()
            .text("💎 VIP-Буст (10 000 ₽)", "set_price_10000").row()
            .text("⬅️ Назад", "back_to_services");
        return ctx.editMessageText("⚡️ **Повышение приоритета**\nВыберите уровень интенсивности услуги:", { reply_markup: kb });
    }

    // Услуга: Анализ (с выбором цен)
    if (data === "service_analysis") {
        ctx.session.currentService = "АНАЛИЗ АККАУНТА";
        const kb = new InlineKeyboard()
            .text("📊 Базовый (990 ₽)", "set_price_990").row()
            .text("🧐 Полный аудит (2 500 ₽)", "set_price_2500").row()
            .text("⬅️ Назад", "back_to_services");
        return ctx.editMessageText("🔍 **Технический анализ**\nВыберите глубину проверки:", { reply_markup: kb });
    }

    if (data === "service_custom") {
        return ctx.editMessageText("💎 **Индивидуальный пакет**\n\nТребуются особые условия? Свяжитесь с менеджером для персонального расчета.\n\n👉 @svoyvtaxi", { reply_markup: new InlineKeyboard().text("⬅️ Назад", "back_to_services") });
    }

    if (data.startsWith("set_price_")) {
        ctx.session.selectedPrice = parseInt(data.split("_")[2]);
        return ctx.editMessageText(`✅ Выбран тариф: **${ctx.session.selectedPrice} ₽**\n\nПродолжить оформление?`, {
            reply_markup: new InlineKeyboard().text("✅ Да, верно", "start_order_flow").row().text("⬅️ Изменить", "back_to_services")
        });
    }

    if (data === "start_order_flow") {
        ctx.session.step = "wait_order_data";
        return ctx.editMessageText("📝 **Идентификация пользователя**\n\nВведите ваш номер телефона или серию/номер В/У:");
    }

    if (data === "confirm_order_data") {
        const orderId = Math.floor(100000 + Math.random() * 900000);
        ADMINS.forEach(id => bot.api.sendMessage(id, 
            `💰 **ГОТОВ К ОПЛАТЕ**\n👤 ${user?.name} (ID: \`${userId}\`)\n🛠 ${ctx.session.currentService}\n💵 ${ctx.session.selectedPrice}₽\n📱 ${ctx.session.tempOrderData}\n🆔 Заказ: #${orderId}`, { parse_mode: "Markdown" }
        ));
        const text = `🎉 **Заказ #${orderId} сформирован!**\nСумма: ${ctx.session.selectedPrice} ₽\n\nНажмите для перехода к оплате:`;
        const kb = new InlineKeyboard().url("💳 Оплатить", "https://t.me/svoyvtaxi").row().text("🔄 Изменить данные", "start_order_flow");
        return ctx.editMessageText(text, { reply_markup: kb });
    }

    if (data === "back_to_services") {
        return ctx.editMessageText("💎 **Выберите интересующую вас услугу:**", { reply_markup: getPaidServicesKeyboard() });
    }

    // Сохраненная логика регистрации
    if (data.startsWith("regcity_")) {
        const city = data.split("_")[1];
        const count = await User.countDocuments();
        const newUser = new User({
            userId: ctx.from.id, username: ctx.from.username || "—",
            displayName: ctx.from.first_name || "Без имени",
            tariff: ctx.session.tariff, city: city,
            name: `Водитель #${count + 1}`, isAllowed: false
        });
        await newUser.save();
        ctx.session.step = "idle";
        await ctx.editMessageText(`✅ Заявка отправлена!\nID: ${newUser.name}\nГород: ${city}`);
        ADMINS.forEach(id => bot.api.sendMessage(id, `🔔 Новая заявка: ${newUser.name} (ID: \`${ctx.from.id}\`)`, { parse_mode: "Markdown" }));
    }

    if (!ADMINS.includes(ctx.from.id)) return;

    if (data.startsWith("manage_")) {
        const tid = data.split("_")[1];
        const u = await User.findOne({ userId: tid });
        const kb = new InlineKeyboard().text("✅ Доступ (31д)", `allow_${tid}`).text("🚫 Блок", `block_${tid}`).row().text("🗑 Удалить", `delete_${tid}`).row().text("⬅️ Назад", "back_to_list");
        await ctx.editMessageText(`👤 **${u.name}**\nID: \`${tid}\`\nДоступ: ${u.isAllowed ? "Да" : "Нет"}`, { reply_markup: kb, parse_mode: "Markdown" });
    }

    if (data === "back_to_list") {
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name || u.userId}`, `manage_${u.userId}`).row());
        await ctx.editMessageText("👥 Список последних водителей:", { reply_markup: kb });
    }

    if (data.startsWith("allow_") || data.startsWith("block_")) {
        const [act, tid] = data.split("_");
        const ok = act === "allow";
        await User.findOneAndUpdate({ userId: tid }, { isAllowed: ok, expiryDate: ok ? dayjs().add(31, 'day').toDate() : null });
        bot.api.sendMessage(tid, ok ? "✅ Доступ одобрен!" : "❌ Доступ ограничен.");
        ctx.answerCallbackQuery("Готово");
    }

    if (data.startsWith("edit_fuel_")) {
        ctx.session.step = "edit_fuel_input";
        ctx.session.editingCity = data.split("_")[2];
        await ctx.answerCallbackQuery();
        return ctx.reply(`📝 Введите новый текст цен для города **${ctx.session.editingCity}**`);
    }

    if (data.startsWith("reply_")) {
        ctx.session.replyToUser = data.split("_")[1];
        await ctx.answerCallbackQuery();
        return ctx.reply(`✍️ Сообщение для ID: ${ctx.session.replyToUser}:`);
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    // КОМАНДА ВЫСТАВЛЕНИЯ СЧЕТА (НОВАЯ)
    if (text.startsWith("/pay") && ADMINS.includes(userId)) {
        const parts = text.split(" ");
        if (parts.length < 3) return ctx.reply("❌ Формат: /pay [ID] [Сумма]");
        const targetId = parts[1];
        const amount = parts[2];
        try {
            await bot.api.sendMessage(targetId, `💎 **Для вас сформирован персональный счет**\n\nСумма к оплате: **${amount} ₽**`, {
                reply_markup: new InlineKeyboard().url("💳 Оплатить картой", "https://t.me/svoyvtaxi")
            });
            return ctx.reply(`✅ Счет на ${amount}₽ отправлен водителю ${targetId}`);
        } catch (e) { return ctx.reply("❌ Ошибка отправки."); }
    }

    // СПИСОК ВОДИТЕЛЕЙ (ИСПРАВЛЕНО)
    if (text === "Список водителей 📋" && ADMINS.includes(userId)) {
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name || u.userId}`, `manage_${u.userId}`).row());
        return ctx.reply("👥 Список последних водителей (нажмите для управления или копирования ID):", { reply_markup: kb });
    }

    if (ctx.session.step === "wait_order_data") {
        ctx.session.tempOrderData = text;
        ctx.session.step = "idle";
        return ctx.reply(`🔍 **Проверьте данные:**\n\n👉 \`${text}\`\n\nВерно?`, { 
            reply_markup: new InlineKeyboard().text("✅ Верно", "confirm_order_data").row().text("🔄 Изменить", "start_order_flow"),
            parse_mode: "Markdown"
        });
    }

    if (ctx.session.step === "edit_fuel_input" && ADMINS.includes(userId)) {
        await Fuel.findOneAndUpdate({ city: ctx.session.editingCity }, { prices: text }, { upsert: true });
        ctx.session.step = "idle";
        return ctx.reply(`✅ Цены для ${ctx.session.editingCity} обновлены!`);
    }

    if (ADMINS.includes(userId) && ctx.session.replyToUser) {
        bot.api.sendMessage(ctx.session.replyToUser, `📩 **Ответ техподдержки:**\n\n${text}`);
        ctx.session.replyToUser = null;
        return ctx.reply("✅ Ответ отправлен.");
    }

    if (ctx.session.step === "wait_support") {
        ctx.session.step = "idle";
        ADMINS.forEach(id => bot.api.sendMessage(id, `🆘 **ПОДДЕРЖКА**\n👤 ${user?.name} (ID: \`${userId}\`)\n💬 ${text}`, { 
            reply_markup: new InlineKeyboard().text("Ответить 💬", `reply_${userId}`),
            parse_mode: "Markdown" 
        }));
        return ctx.reply("✅ Ваше сообщение передано оператору.");
    }

    // ТВОИ БАЗОВЫЕ КНОПКИ
    if (text === "Открыть карту 🔥") {
        if (ADMINS.includes(userId) || (user?.isAllowed && user.expiryDate > new Date())) {
            return ctx.reply("📍 Карта готова:", { reply_markup: new InlineKeyboard().webApp("Запустить", `${webAppUrl}?city=${encodeURIComponent(user?.city || 'Москва')}`) });
        }
        return ctx.reply("🚫 Нет доступа.");
    }
    if (text === "Буст аккаунта ⚡️") {
        return ctx.reply("⚡️ Система ускорения:", { reply_markup: new InlineKeyboard().webApp("Запустить Буст", `${webAppUrl}?page=boost&id=${user?.name || 'Driver'}`) });
    }
    if (text === "Техподдержка 🆘") {
        ctx.session.step = "wait_support";
        return ctx.reply("👨‍💻 **Служба поддержки**\n\nВведите ваше сообщение:");
    }
    if (text === "Платные услуги 💎") {
        return ctx.reply("💎 **Выберите интересующую вас услугу:**", { reply_markup: getPaidServicesKeyboard() });
    }
    if (text === "Цены на топливо ⛽️") {
        const f = await Fuel.findOne({ city: user?.city });
        const kb = new InlineKeyboard();
        if (ADMINS.includes(userId)) kb.text("Изменить цены 📝", `edit_fuel_${user?.city}`);
        return ctx.reply(`⛽️ **Цены ${user?.city}:**\n\n${f ? f.prices : "Нет данных"}`, { reply_markup: kb });
    }
    if (text === "Мой профиль 👤") {
        const exp = user?.expiryDate ? dayjs(user.expiryDate).format("DD.MM.YYYY") : "Нет";
        return ctx.reply(`👤 **Профиль:**\nID: ${user?.name}\nВаш ID: \`${userId}\`\nДоступ до: ${exp}`, { parse_mode: "Markdown" });
    }
    if (text === "Аналитика 📊" && ADMINS.includes(userId)) {
        const u = await User.countDocuments();
        const e = await Event.countDocuments();
        const t = await Taxi.countDocuments();
        return ctx.reply(`📊 Статистика:\nВодителей: ${u}\nЗон (KudaGo): ${e}\nМашин в базе: ${t}`);
    }
    if (text === "Обновить карту 🔄" && ADMINS.includes(userId)) {
        const count = await updateAllCities();
        return ctx.reply(`✅ Карта обновлена! Добавлено зон: ${count}`);
    }
    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        return ctx.reply("🏙 Выберите город:", { reply_markup: getCitiesKeyboard() });
    }
});

bot.catch((err) => console.error(err));
bot.start();

// --- 🌐 API СЕРВЕР (ТВОЙ КОД) ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.url.startsWith('/api/points')) {
        const city = url.searchParams.get('city') || "Москва";
        const lat = parseFloat(url.searchParams.get('lat'));
        const lng = parseFloat(url.searchParams.get('lng'));
        if (!isNaN(lat) && !isNaN(lng)) await generateTaxisInDatabase(lat, lng, city);
        const events = await Event.find({ city });
        let taxis = !isNaN(lat) && !isNaN(lng) ? await Taxi.find({ lat: { $gt: lat - 0.25, $lt: lat + 0.25 }, lng: { $gt: lng - 0.25, $lt: lng + 0.25 } }).limit(40) : await Taxi.find({ city }).limit(20);
        res.end(JSON.stringify({ events, taxis }));
    } else res.end(JSON.stringify({ status: "running" }));
});
server.listen(process.env.PORT || 8080);