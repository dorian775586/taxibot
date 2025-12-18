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

bot.use(session({ initial: () => ({ step: "idle", tariff: null, replyToUser: null, editingCity: null }) }));

// --- 🚀 ГЕНЕРАЦИЯ ТАКСИ (ПРИНЦИП ФИОЛЕТОВЫХ ЗОН) ---
async function generateTaxisInDatabase(userLat, userLng, cityName) {
    // Чистим старые машины перед созданием новых, чтобы не забивать базу
    await Taxi.deleteMany({
        $or: [
            { expireAt: { $lt: new Date() } },
            { 
              lat: { $gt: userLat - 0.2, $lt: userLat + 0.2 },
              lng: { $gt: userLng - 0.2, $lt: userLng + 0.2 }
            }
        ]
    });
    
    const newTaxis = [];
    const count = 25; 

    for (let i = 0; i < count; i++) {
        // Разброс строго в радиусе ~15 км от GPS
        let lat = userLat + (Math.random() - 0.5) * 0.18; 
        let lng = userLng + (Math.random() - 0.5) * 0.18;

        newTaxis.push({
            city: cityName, 
            lat: lat, 
            lng: lng,
            expireAt: dayjs().add(15, 'minute').toDate()
        });
    }
    
    if (newTaxis.length) {
        await Taxi.insertMany(newTaxis);
    }
    return newTaxis;
}

// --- 🚀 ОБНОВЛЕНИЕ ЗОН ПО ВСЕМ ГОРОДАМ ---
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
        .text("Анализ аккаунта 🔍").row()
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

    if (data === "accept_analysis") {
        ctx.session.step = "wait_phone";
        return ctx.editMessageText("📞 Пожалуйста, введите ваш контактный номер телефона для связи со специалистом техподдержки:");
    }

    if (data === "cancel_analysis") {
        return ctx.editMessageText("🏠 Вы вернулись в меню. Выберите нужный раздел.");
    }

    if (data.startsWith("regcity_")) {
        const city = data.split("_")[1];
        const count = await User.countDocuments();
        const user = new User({
            userId: ctx.from.id, username: ctx.from.username || "—",
            displayName: ctx.from.first_name || "Без имени",
            tariff: ctx.session.tariff, city: city,
            name: `Водитель #${count + 1}`, isAllowed: false
        });
        await user.save();
        ctx.session.step = "idle";
        await ctx.editMessageText(`✅ Заявка отправлена!\nID: ${user.name}\nГород: ${city}\n\nОжидайте активации админом.`);
        ADMINS.forEach(id => bot.api.sendMessage(id, `🔔 Новая заявка: ${user.name} (@${ctx.from.username || 'нет'})`));
    }

    if (!ADMINS.includes(ctx.from.id)) return;

    if (data.startsWith("manage_")) {
        const tid = data.split("_")[1];
        const u = await User.findOne({ userId: tid });
        const kb = new InlineKeyboard().text("✅ Доступ (31д)", `allow_${tid}`).text("🚫 Блок", `block_${tid}`).row().text("🗑 Удалить", `delete_${tid}`).row().text("⬅️ Назад", "back_to_list");
        await ctx.editMessageText(`👤 **${u.name}**\nГород: ${u.city}\nДоступ: ${u.isAllowed ? "Да" : "Нет"}`, { reply_markup: kb });
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
        bot.api.sendMessage(tid, ok ? "✅ Доступ одобрен на 31 день!" : "❌ Доступ ограничен.");
        ctx.answerCallbackQuery("Готово");
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    if (ctx.session.step === "edit_fuel_input" && ADMINS.includes(userId)) {
        await Fuel.findOneAndUpdate({ city: ctx.session.editingCity }, { prices: text }, { upsert: true });
        ctx.session.step = "idle";
        return ctx.reply(`✅ Цены для города **${ctx.session.editingCity}** обновлены!`);
    }

    if (ADMINS.includes(userId) && ctx.session.replyToUser) {
        try {
            await bot.api.sendMessage(ctx.session.replyToUser, `📩 **Сообщение от техподдержки:**\n\n${text}`, { parse_mode: "Markdown" });
            await ctx.reply(`✅ Ответ отправлен водителю.`);
        } catch (e) { ctx.reply("❌ Ошибка отправки."); }
        ctx.session.replyToUser = null;
        return;
    }

    if (ctx.session.step === "wait_support") {
        ctx.session.step = "idle";
        const supportMsg = `🆘 **НОВОЕ ОБРАЩЕНИЕ В ПОДДЕРЖКУ**\n\n👤 **Водитель:** ${user?.name || '—'}\n🏙 **Город:** ${user?.city || '—'}\n💬 **Сообщение:** ${text}`;
        ADMINS.forEach(id => bot.api.sendMessage(id, supportMsg, { reply_markup: new InlineKeyboard().text("Ответить 💬", `reply_${userId}`) }));
        return ctx.reply("✅ Ваше обращение принято. Мы ответим вам здесь в ближайшее время.", { parse_mode: "Markdown" });
    }

    if (ctx.session.step === "wait_phone") {
        ctx.session.step = "idle";
        ADMINS.forEach(id => bot.api.sendMessage(id, `🚀 **ЗАЯВКА НА АНАЛИЗ**\n👤 Имя: ${user?.name || '—'}\n📍 Город: ${user?.city || '—'}\n📞 Номер: ${text}`));
        return ctx.reply("✅ Ваша заявка принята!");
    }

    if (text === "Открыть карту 🔥") {
        if (ADMINS.includes(userId) || (user?.isAllowed && user.expiryDate > new Date())) {
            return ctx.reply("📍 Карта готова:", { reply_markup: new InlineKeyboard().webApp("Запустить", `${webAppUrl}?city=${encodeURIComponent(user?.city || 'Москва')}`) });
        }
        return ctx.reply("🚫 Нет доступа.");
    }

    if (text === "Буст аккаунта ⚡️") {
        if (ADMINS.includes(userId) || (user?.isAllowed && user.expiryDate > new Date())) {
            return ctx.reply("⚡️ Система ускорения:", { reply_markup: new InlineKeyboard().webApp("Запустить Буст", `${webAppUrl}?page=boost&id=${user?.name || 'Driver'}`) });
        }
        return ctx.reply("🚫 Доступ закрыт.");
    }

    if (text === "Техподдержка 🆘") {
        ctx.session.step = "wait_support";
        return ctx.reply("👋 Напишите вашу проблему подробно. Мы изучим обращение и ответим здесь.", { reply_markup: { remove_keyboard: true } });
    }

    if (text === "Анализ аккаунта 🔍") {
        const kb = new InlineKeyboard().text("✅ Согласен", "accept_analysis").text("❌ Отмена", "cancel_analysis");
        return ctx.reply("📈 Заказать анализ аккаунта на предмет теневых ограничений?", { reply_markup: kb });
    }

    if (text === "Цены на топливо ⛽️") {
        if (!user) return;
        const f = await Fuel.findOne({ city: user.city });
        const kb = new InlineKeyboard();
        if (ADMINS.includes(userId)) kb.text("Изменить цены 📝", `edit_fuel_${user.city}`);
        return ctx.reply(`⛽️ **Цены ${user.city}:**\n\n${f ? f.prices : "Нет данных"}`, { parse_mode: "Markdown", reply_markup: kb });
    }

    if (text === "Мой профиль 👤") {
        const exp = user?.expiryDate ? dayjs(user.expiryDate).format("DD.MM.YYYY") : "Нет";
        return ctx.reply(`👤 **Профиль:**\nID: ${user?.name}\nГород: ${user?.city}\nДоступ до: ${exp}`, { parse_mode: "Markdown" });
    }

    if (text === "Аналитика 📊" && ADMINS.includes(userId)) {
        const u = await User.countDocuments();
        const e = await Event.countDocuments();
        const t = await Taxi.countDocuments();
        return ctx.reply(`📊 Статистика:\nВодителей: ${u}\nЗон: ${e}\nМашин: ${t}`);
    }

    if (text === "Список водителей 📋" && ADMINS.includes(userId)) {
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name || u.userId}`, `manage_${u.userId}`).row());
        return ctx.reply("👥 Список водителей:", { reply_markup: kb });
    }

    if (text === "Обновить карту 🔄" && ADMINS.includes(userId)) {
        await ctx.reply("📡 Обновляю точки...");
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

// --- 🌐 API СЕРВЕР (ГЕНЕРАЦИЯ ЧЕРЕЗ БАЗУ) ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (req.url.startsWith('/api/points') || req.url.startsWith('/api/data')) {
        const city = url.searchParams.get('city') || "Москва";
        const lat = parseFloat(url.searchParams.get('lat'));
        const lng = parseFloat(url.searchParams.get('lng'));
        
        // 1. Если пришли координаты, создаем машины в базе
        if (!isNaN(lat) && !isNaN(lng)) {
            await generateTaxisInDatabase(lat, lng, city);
        }

        // 2. Достаем зоны из базы
        const events = await Event.find({ city });
        
        // 3. Достаем машины из базы (только те, что рядом с водителем)
        let taxis = [];
        if (!isNaN(lat) && !isNaN(lng)) {
            taxis = await Taxi.find({
                lat: { $gt: lat - 0.2, $lt: lat + 0.2 },
                lng: { $gt: lng - 0.2, $lt: lng + 0.2 }
            }).limit(30);
        } else {
            taxis = await Taxi.find({ city }).limit(20);
        }
        
        res.end(JSON.stringify({ events, taxis }));
    } else {
        res.end(JSON.stringify({ status: "running" }));
    }
});
server.listen(process.env.PORT || 8080);