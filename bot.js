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
    tariff: { type: String, default: "Стандарт" }, 
    city: { type: String, default: "Москва" },
    isAllowed: { type: Boolean, default: true }, 
    expiryDate: { type: Date, default: () => dayjs().add(10, 'year').toDate() }, 
    username: String, 
    displayName: String, 
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

bot.use(session({ 
    initial: () => ({ 
        step: "idle", 
        replyToUser: null, 
        editingCity: null,
        tempOrderData: null, 
        currentService: null,
        selectedPrice: 0 
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
    for (let i = 0; i < 20; i++) {
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
        const count = await User.countDocuments();
        user = new User({
            userId: ctx.from.id,
            username: ctx.from.username || "—",
            displayName: ctx.from.first_name || "Без имени",
            name: `Водитель #${count + 1}`,
            isAllowed: true
        });
        await user.save();
        
        const welcomeText = `👋 **Приветствуем в HotMap!**\n\n` +
                            `Мы предлагаем вам актуальную **карту активности** и зон повышенного спроса, чтобы ваш заработок всегда был на высоте. 🔥\n\n` +
                            `Также вам доступны наши **платные услуги**, с которыми вы можете ознакомиться в любое время по кнопке в меню.\n\n` +
                            `✨ Приятного использования!`;
        return ctx.reply(welcomeText, { reply_markup: getMainKeyboard(ctx.from.id), parse_mode: "Markdown" });
    }

    await ctx.reply(`🏠 **Главное меню**\nСтатус: 🟢 Активен`, { reply_markup: getMainKeyboard(ctx.from.id), parse_mode: "Markdown" });
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    if (data === "service_priority") {
        ctx.session.currentService = "ПОВЫШЕНИЕ ПРИОРИТЕТА";
        const text = `⚡️ **Услуга: Повышение приоритета**\n\n` +
                     `Данная услуга позволяет программно оптимизировать ваш профиль в системе распределения заказов. Это увеличивает частоту получения "дорогих" заказов и снижает время простоя.\n\n` +
                     `🕒 **Срок выполнения:** 24 часа.\n\n` +
                     `**Выберите подходящий пакет:**\n` +
                     `🔹 **Стандарт (2 000 ₽):** Оптимизация базовых параметров профиля для стабильного потока заказов.\n` +
                     `🔥 **Срочный (5 000 ₽):** Ускоренная подача данных. Приоритетный статус в очереди на распределение.\n` +
                     `💎 **VIP-Буст (10 000 ₽):** Максимально возможный уровень приоритета + личный мониторинг администратора.\n\n` +
                     `⚠️ *Если что-то пошло не так, обязательно нажимайте кнопку "Техподдержка" для связи с администратором.*`;
        const kb = new InlineKeyboard()
            .text("🔹 Стандарт (2 000 ₽)", "set_price_2000").row()
            .text("🔥 Срочный (5 000 ₽)", "set_price_5000").row()
            .text("💎 VIP-Буст (10 000 ₽)", "set_price_10000").row()
            .text("⬅️ Назад", "back_to_services");
        return ctx.editMessageText(text, { reply_markup: kb, parse_mode: "Markdown" });
    }

    if (data === "service_analysis") {
        ctx.session.currentService = "АНАЛИЗ АККАУНТА";
        const text = `🔍 **Услуга: Глубокий анализ аккаунта**\n\n` +
                     `Мы проведем полный аудит вашего ID в системе, выявим скрытые ограничения (флажки) и причины низкого дохода, которые не видны в обычном приложении.\n\n` +
                     `🕒 **Срок выполнения:** 24 часа.\n\n` +
                     `**Варианты анализа:**\n` +
                     `📊 **Базовый (990 ₽):** Выгрузка текущего рейтинга и скрытых жалоб от клиентов.\n` +
                     `🧐 **Полный аудит (2 500 ₽):** Детальный технический отчет + рекомендации по исправлению "кармы" аккаунта.\n\n` +
                     `⚠️ *Если что-то пошло не так, обязательно нажимайте кнопку "Техподдержка" для связи с администратором.*`;
        const kb = new InlineKeyboard()
            .text("📊 Базовый (990 ₽)", "set_price_990").row()
            .text("🧐 Полный аудит (2 500 ₽)", "set_price_2500").row()
            .text("⬅️ Назад", "back_to_services");
        return ctx.editMessageText(text, { reply_markup: kb, parse_mode: "Markdown" });
    }

    if (data === "service_custom") {
        return ctx.editMessageText("💎 **Индивидуальный расчет**\n\nЕсли у вас специфический запрос или сложная блокировка, свяжитесь напрямую с администратором для формирования персонального предложения.\n\n👉 @svoyvtaxi\n\n⚠️ *Также доступна кнопка Техподдержка в меню.*", { reply_markup: new InlineKeyboard().text("⬅️ Назад", "back_to_services") });
    }

    if (data.startsWith("set_price_")) {
        ctx.session.selectedPrice = parseInt(data.split("_")[2]);
        return ctx.editMessageText(`✅ Выбранный тариф: **${ctx.session.selectedPrice} ₽**\n\nНачинаем идентификацию?`, {
            reply_markup: new InlineKeyboard().text("✅ Да, поехали", "start_order_flow").row().text("⬅️ Назад", "back_to_services"),
            parse_mode: "Markdown"
        });
    }

    if (data === "start_order_flow") {
        ctx.session.step = "wait_order_data";
        return ctx.editMessageText("📝 **Шаг 2: Идентификация**\n\nВведите ваш рабочий номер телефона (Яндекс Про) или серию и номер В/У для привязки услуги к вашему профилю:");
    }

    if (data === "confirm_order_data") {
        const orderId = Math.floor(100000 + Math.random() * 900000);
        ADMINS.forEach(id => bot.api.sendMessage(id, `💰 **ГОТОВ К ОПЛАТЕ**\n👤 ${user?.name} (ID: \`${userId}\`)\n🛠 Услуга: ${ctx.session.currentService}\n💵 Сумма: ${ctx.session.selectedPrice}₽\n📱 Данные: ${ctx.session.tempOrderData}\n🆔 Заказ: #${orderId}`, { parse_mode: "Markdown" }));
        
        const text = `🎉 **Данные получены!**\n\nВаш запрос на "${ctx.session.currentService}" принят. К оплате: **${ctx.session.selectedPrice} ₽**.\n\n🕒 Время активации после оплаты: до 24 часов.\n\nДля оплаты напишите администратору: @svoyvtaxi\n\n⚠️ *Если у вас возникли вопросы, нажмите кнопку "Техподдержка" в главном меню.*`;
        return ctx.editMessageText(text, { reply_markup: new InlineKeyboard().url("💳 Оплатить", "https://t.me/svoyvtaxi"), parse_mode: "Markdown" });
    }

    if (data === "back_to_services") {
        return ctx.editMessageText("💎 **Выберите интересующую вас услугу:**", { reply_markup: getPaidServicesKeyboard() });
    }

    // АДМИН ПАНЕЛЬ
    if (!ADMINS.includes(userId)) return;

    if (data.startsWith("manage_")) {
        const tid = data.split("_")[1];
        const u = await User.findOne({ userId: tid });
        if (!u) return ctx.answerCallbackQuery("Пользователь не найден");
        const kb = new InlineKeyboard()
            .text("✅ Доступ", `allow_${tid}`).text("🚫 Блок", `block_${tid}`).row()
            .text("✍️ Написать", `reply_${tid}`).text("🗑 Удалить", `delete_${tid}`).row()
            .text("⬅️ Назад", "back_to_list");
        await ctx.editMessageText(`👤 **${u.name}**\nID: \`${tid}\`\nДоступ: ${u.isAllowed ? "Да" : "Нет"}`, { reply_markup: kb, parse_mode: "Markdown" });
    }

    if (data === "back_to_list") {
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row());
        await ctx.editMessageText("👥 Список водителей:", { reply_markup: kb });
    }

    if (data.startsWith("delete_")) {
        const tid = data.split("_")[1];
        await User.deleteOne({ userId: tid });
        await ctx.answerCallbackQuery("Профиль удален");
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row());
        return ctx.editMessageText("👥 Список водителей (обновлено):", { reply_markup: kb });
    }

    if (data.startsWith("allow_") || data.startsWith("block_")) {
        const [act, tid] = data.split("_");
        const ok = act === "allow";
        await User.findOneAndUpdate({ userId: tid }, { isAllowed: ok });
        ctx.answerCallbackQuery("Готово");
    }

    if (data.startsWith("reply_")) {
        ctx.session.replyToUser = data.split("_")[1];
        return ctx.reply(`✍️ Введите сообщение для водителя ID: ${ctx.session.replyToUser}:`);
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    if (ctx.session.step === "wait_order_data") {
        ctx.session.tempOrderData = text;
        ctx.session.step = "idle";
        const kb = new InlineKeyboard().text("✅ Верно", "confirm_order_data").text("🔄 Изменить", "start_order_flow");
        return ctx.reply(`🔍 **Проверьте данные:**\n\n👉 \`${text}\`\n\nВсё верно?`, { reply_markup: kb, parse_mode: "Markdown" });
    }

    if (ADMINS.includes(userId) && ctx.session.replyToUser) {
        bot.api.sendMessage(ctx.session.replyToUser, `📩 **Сообщение от администрации:**\n\n${text}`);
        ctx.session.replyToUser = null;
        return ctx.reply("✅ Отправлено.");
    }

    if (ctx.session.step === "wait_support") {
        ctx.session.step = "idle";
        ADMINS.forEach(id => bot.api.sendMessage(id, `🆘 **ПОДДЕРЖКА**\n👤 ${user?.name}\n💬 ${text}`, { reply_markup: new InlineKeyboard().text("Ответить", `reply_${userId}`) }));
        return ctx.reply("✅ Ваше сообщение отправлено в поддержку. Ожидайте ответа администратора.");
    }

    if (text === "Открыть карту 🔥") {
        if (user?.isAllowed) {
            return ctx.reply("📍 Карта готова:", { reply_markup: new InlineKeyboard().webApp("Запустить", `${webAppUrl}?city=${encodeURIComponent(user?.city || 'Москва')}`) });
        }
        return ctx.reply("🚫 Доступ ограничен.");
    }
    if (text === "Буст аккаунта ⚡️") {
        return ctx.reply("⚡️ Ускорение профиля:", { reply_markup: new InlineKeyboard().webApp("Запустить Буст", `${webAppUrl}?page=boost&id=${user?.name || 'Driver'}`) });
    }
    if (text === "Платные услуги 💎") {
        return ctx.reply("💎 **Выберите интересующую вас услугу:**", { reply_markup: getPaidServicesKeyboard() });
    }
    if (text === "Мой профиль 👤") {
        return ctx.reply(`👤 **Профиль:**\nID: ${user?.name}\nСтатус: 🟢 Активен\nГород: ${user?.city}\n\n⚠️ *По всем вопросам пишите в техподдержку.*`, { parse_mode: "Markdown" });
    }
    if (text === "Техподдержка 🆘") {
        ctx.session.step = "wait_support";
        return ctx.reply("👨‍💻 **Связь с администратором**\n\nВведите ваше сообщение. Администратор свяжется с вами в ближайшее время для решения любых вопросов:");
    }
    if (text === "Список водителей 📋" && ADMINS.includes(userId)) {
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row());
        return ctx.reply("👥 Список водителей:", { reply_markup: kb });
    }
    if (text === "Обновить карту 🔄" && ADMINS.includes(userId)) {
        const count = await updateAllCities();
        return ctx.reply(`✅ Обновлено зон: ${count}`);
    }
});

bot.catch((err) => console.error(err));

bot.start({
    onStart: (botInfo) => console.log(`Бот @${botInfo.username} запущен`),
    drop_pending_updates: true 
});

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.url.startsWith('/api/points')) {
        const city = url.searchParams.get('city') || "Москва";
        const lat = parseFloat(url.searchParams.get('lat'));
        const lng = parseFloat(url.searchParams.get('lng'));
        if (!isNaN(lat) && !isNaN(lng)) await generateTaxisInDatabase(lat, lng, city);
        const [events, taxis] = await Promise.all([Event.find({ city }), Taxi.find({ city }).limit(30)]);
        res.end(JSON.stringify({ events, taxis }));
    } else res.end(JSON.stringify({ status: "running" }));
});
server.listen(process.env.PORT || 8080);