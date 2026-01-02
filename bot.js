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

// Инициализация сессии с новыми полями для сбора данных заказа
bot.use(session({ 
    initial: () => ({ 
        step: "idle", 
        tariff: null, 
        replyToUser: null, 
        editingCity: null,
        tempOrderData: null, 
        currentService: null 
    }) 
}));

// --- 🚀 ГЕНЕРАЦИЯ ТАКСИ ---
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
            city: cityName, 
            lat: lat, 
            lng: lng,
            expireAt: dayjs().add(20, 'minute').toDate()
        });
    }
    
    if (newTaxis.length) {
        await Taxi.insertMany(newTaxis);
    }
    return newTaxis;
}

// --- 🚀 ОБНОВЛЕНИЕ ЗОН ---
async function updateAllCities() {
    const CITIES_LIST = [
        { slug: "msk", name: "Москва" },
        { slug: "spb", name: "Санкт-Петербург" },
        { slug: "nsk", name: "Новосибирск" },
        { slug: "ekb", name: "Екатеринбург" },
        { slug: "kzn", name: "Казань" },
        { slug: "che", name: "Челябинск" }
    ];

    await Event.deleteMany({}); 
    let total = 0;

    for (const cityObj of CITIES_LIST) {
        try {
            const url = `https://kudago.com/public-api/v1.4/events/?location=${cityObj.slug}&fields=place,dates,title&page_size=50&expand=place&actual_since=${Math.floor(Date.now()/1000)}`;
            const { data } = await axios.get(url);
            
            const events = data.results
                .filter(i => i.place && i.place.coords)
                .map(i => ({
                    city: cityObj.name,
                    title: i.title,
                    address: i.place.address,
                    lat: i.place.coords.lat,
                    lng: i.place.coords.lon,
                    expireAt: dayjs().add(2, 'hour').toDate()
                }));

            if (events.length > 0) { 
                await Event.insertMany(events); 
                total += events.length; 
            }
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
        .text("🔍 Глубокий анализ аккаунта", "service_analysis").row();
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

    // Услуга: Приоритет
    if (data === "service_priority") {
        ctx.session.currentService = "ПОВЫШЕНИЕ ПРИОРИТЕТА";
        const text = `⚡️ **Профессиональное повышение приоритета**\n\n` +
                     `Данная услуга позволяет искусственно оптимизировать ваш профиль в системе распределения заказов. Наша команда инсайдеров вносит корректировки в CRM, которые позволяют вашему аккаунту получать заказы в «первой очереди».\n\n` +
                     `✅ **Срок выполнения:** до 24 часов.\n` +
                     `🛡 **Гарантия:** Мы работаем через прямой доступ. Если в течение суток изменения не вступили в силу — немедленно жмите кнопку «Техподдержка», мы разберемся в ситуации.\n\n` +
                     `💳 **Стоимость:** 1 990 ₽`;
        const kb = new InlineKeyboard().text("✅ Я согласен", "start_order_flow").row().text("⬅️ Назад", "back_to_services");
        return ctx.editMessageText(text, { reply_markup: kb, parse_mode: "Markdown" });
    }

    // Услуга: Анализ
    if (data === "service_analysis") {
        ctx.session.currentService = "АНАЛИЗ АККАУНТА";
        const text = `🔍 **Глубокий технический анализ аккаунта**\n\n` +
                     `Мы выгрузим полные данные по вашему ID из внутренней системы администрирования. Вы узнаете всё, что скрыто от глаз водителя и таксопарка:\n\n` +
                     `🔹 Наличие скрытых (теневых) блокировок и их причины.\n` +
                     `🔹 Реальная причина низкого приоритета и методы исправления.\n` +
                     `🔹 История жалоб, которые не отображаются в Яндекс Про.\n` +
                     `🔹 Полный аудит профиля на наличие «флажков» от СБ.\n\n` +
                     `💳 **Стоимость:** 990 ₽`;
        const kb = new InlineKeyboard().text("✅ Я согласен", "start_order_flow").row().text("⬅️ Назад", "back_to_services");
        return ctx.editMessageText(text, { reply_markup: kb, parse_mode: "Markdown" });
    }

    // Сбор данных (телефон или ВУ)
    if (data === "start_order_flow") {
        ctx.session.step = "wait_order_data";
        return ctx.editMessageText("📝 **Идентификация пользователя**\n\nДля того чтобы мы нашли вас в базе и произвели услугу, введите ваш рабочий номер телефона (привязанный к Яндекс Про) или серию и номер водительского удостоверения (В/У):");
    }

    // Подтверждение данных перед оплатой
    if (data === "confirm_order_data") {
        const orderId = Math.floor(100000 + Math.random() * 900000);
        // Уведомление админам о готовности к оплате
        ADMINS.forEach(id => bot.api.sendMessage(id, 
            `💰 **ГОТОВ К ОПЛАТЕ**\n👤 ${user?.name}\n🛠 Услуга: ${ctx.session.currentService}\n📱 Данные: ${ctx.session.tempOrderData}\n🆔 Заказ: #${orderId}`
        ));

        const text = `🎉 **Данные проверены!**\n\nВаш запрос на услугу "${ctx.session.currentService}" принят. Нажмите кнопку ниже для перехода к оплате. После оплаты услуга будет активирована автоматически в течение указанного срока.`;
        const kb = new InlineKeyboard().url("💳 Оплатить", "https://t.me/svoyvtaxi").row().text("🔄 Изменить данные", "start_order_flow");
        return ctx.editMessageText(text, { reply_markup: kb });
    }

    if (data === "back_to_services") {
        return ctx.editMessageText("💎 **Выберите интересующую вас услугу:**", { reply_markup: getPaidServicesKeyboard() });
    }

    // Сохраненная логика админки и регистрации
    if (data.startsWith("edit_fuel_")) {
        ctx.session.step = "edit_fuel_input";
        ctx.session.editingCity = data.split("_")[2];
        await ctx.answerCallbackQuery();
        return ctx.reply(`📝 Введите новый текст цен для города **${ctx.session.editingCity}**`);
    }

    if (data.startsWith("reply_")) {
        ctx.session.replyToUser = data.split("_")[1];
        await ctx.answerCallbackQuery();
        return ctx.reply(`✍️ Введите сообщение для ответа водителю (ID: ${ctx.session.replyToUser}):`);
    }

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
        ADMINS.forEach(id => bot.api.sendMessage(id, `🔔 Новая заявка: ${newUser.name} (@${ctx.from.username || 'нет'})`));
    }

    if (!ADMINS.includes(ctx.from.id)) return;

    if (data.startsWith("manage_")) {
        const tid = data.split("_")[1];
        const u = await User.findOne({ userId: tid });
        const kb = new InlineKeyboard().text("✅ Доступ (31д)", `allow_${tid}`).text("🚫 Блок", `block_${tid}`).row().text("🗑 Удалить", `delete_${tid}`).row().text("⬅️ Назад", "back_to_list");
        await ctx.editMessageText(`👤 **${u.name}**\nДоступ: ${u.isAllowed ? "Да" : "Нет"}`, { reply_markup: kb });
    }

    if (data === "back_to_list") {
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name || u.userId}`, `manage_${u.userId}`).row());
        await ctx.editMessageText("👥 Список водителей:", { reply_markup: kb });
    }

    if (data.startsWith("allow_") || data.startsWith("block_")) {
        const [act, tid] = data.split("_");
        const ok = act === "allow";
        await User.findOneAndUpdate({ userId: tid }, { isAllowed: ok, expiryDate: ok ? dayjs().add(31, 'day').toDate() : null });
        bot.api.sendMessage(tid, ok ? "✅ Доступ одобрен!" : "❌ Доступ ограничен.");
        ctx.answerCallbackQuery("Готово");
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    // Обработка ввода данных для платных услуг
    if (ctx.session.step === "wait_order_data") {
        ctx.session.tempOrderData = text;
        ctx.session.step = "idle";
        const kb = new InlineKeyboard()
            .text("✅ Данные верны", "confirm_order_data")
            .row()
            .text("🔄 Изменить", "start_order_flow");
        
        return ctx.reply(`🔍 **Проверьте введенные данные:**\n\n👉 \`${text}\`\n\nВсе верно? Эти данные будут использованы для привязки услуги к вашему аккаунту ЯндексGo.`, { 
            reply_markup: kb, 
            parse_mode: "Markdown" 
        });
    }

    if (ctx.session.step === "edit_fuel_input" && ADMINS.includes(userId)) {
        await Fuel.findOneAndUpdate({ city: ctx.session.editingCity }, { prices: text }, { upsert: true });
        ctx.session.step = "idle";
        return ctx.reply(`✅ Цены для города **${ctx.session.editingCity}** обновлены!`);
    }

    if (ADMINS.includes(userId) && ctx.session.replyToUser) {
        bot.api.sendMessage(ctx.session.replyToUser, `📩 **Сообщение от техподдержки:**\n\n${text}`);
        ctx.session.replyToUser = null;
        return ctx.reply("✅ Ответ отправлен.");
    }

    if (ctx.session.step === "wait_support") {
        ctx.session.step = "idle";
        ADMINS.forEach(id => bot.api.sendMessage(id, `🆘 **ПОДДЕРЖКА**\n👤 ${user?.name}\n💬 ${text}`, { reply_markup: new InlineKeyboard().text("Ответить 💬", `reply_${userId}`) }));
        return ctx.reply("✅ Ваше обращение принято и передано специалистам.");
    }

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
        return ctx.reply("👨‍💻 **Служба поддержки**\n\nЗдравствуйте! Ваш запрос будет передан первому освободившемуся оператору. \n\n⏱ Среднее время ожидания ответа: **20 минут**.\n\nПожалуйста, введите ваше сообщение ниже:");
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
        return ctx.reply(`👤 **Профиль:**\nID: ${user?.name}\nГород: ${user?.city}\nДоступ до: ${exp}`);
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

// --- 🌐 API СЕРВЕР ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (req.url.startsWith('/api/points')) {
        const city = url.searchParams.get('city') || "Москва";
        const lat = parseFloat(url.searchParams.get('lat'));
        const lng = parseFloat(url.searchParams.get('lng'));
        
        if (!isNaN(lat) && !isNaN(lng)) {
            await generateTaxisInDatabase(lat, lng, city);
        }

        const events = await Event.find({ city });
        
        let taxis = [];
        if (!isNaN(lat) && !isNaN(lng)) {
            taxis = await Taxi.find({
                lat: { $gt: lat - 0.25, $lt: lat + 0.25 },
                lng: { $gt: lng - 0.25, $lt: lng + 0.25 }
            }).limit(40);
        } else {
            taxis = await Taxi.find({ city }).limit(20);
        }
        
        res.end(JSON.stringify({ events, taxis }));
    } else {
        res.end(JSON.stringify({ status: "running" }));
    }
});
server.listen(process.env.PORT || 8080);