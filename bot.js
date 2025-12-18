const { Bot, Keyboard, InlineKeyboard, session, GrammyError, HttpError } = require("grammy");
const mongoose = require("mongoose");
const http = require("http");
const dayjs = require("dayjs");
const axios = require("axios");
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

// Настройка работы со временем
dayjs.extend(utc);
dayjs.extend(timezone);

// --- ⚙️ НАСТРОЙКИ ---
const token = "7973955726:AAFpMltfoqwO902Q1su5j6HWipPxEJYM3-o";
const webAppUrl = "https://hotmaptaxi-git-main-dorians-projects-14978635.vercel.app";
const mongoUri = "mongodb+srv://user775586:user775586@cluster0.36spuej.mongodb.net/?appName=Cluster0"; 

const ADMIN_ID = 623203896; 
const SECOND_ADMIN_ID = 7469074713; 
const ADMINS = [ADMIN_ID, SECOND_ADMIN_ID];

const bot = new Bot(token);

// --- 🗄️ БАЗА ДАННЫХ ---
mongoose.connect(mongoUri).then(() => console.log("✅ База подключена"));

const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: { type: String, default: "Водитель" }, 
    tariff: String, 
    city: String,
    isAllowed: { type: Boolean, default: false },
    expiryDate: { type: Date, default: null }, 
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

bot.use(session({ initial: () => ({ step: "idle", tariff: null, replyToUser: null, editingCity: null }) }));

// --- 🚀 ГЕНЕРАЦИЯ МАШИН ВОКРУГ GPS ---
async function generateTaxisAroundUser(userLat, userLng, cityName) {
    await Taxi.deleteMany({ expireAt: { $lt: new Date() } });
    const zones = await Event.find({ city: cityName });

    const newTaxis = [];
    const count = 15 + Math.floor(Math.random() * 10); 

    for (let i = 0; i < count; i++) {
        let lat = userLat + (Math.random() - 0.5) * 0.2; 
        let lng = userLng + (Math.random() - 0.5) * 0.2;

        let inZone = zones.some(z => {
            const dist = Math.sqrt(Math.pow(z.lat - lat, 2) + Math.pow(z.lng - lng, 2));
            return dist < 0.015; 
        });

        if (inZone && Math.random() > 0.1) {
            lat += (Math.random() > 0.5 ? 0.025 : -0.025);
            lng += (Math.random() > 0.5 ? 0.025 : -0.025);
        }

        newTaxis.push({
            city: cityName, lat: lat, lng: lng,
            expireAt: dayjs().add(10, 'minute').toDate()
        });
    }
    
    if (newTaxis.length) await Taxi.insertMany(newTaxis);
    return newTaxis;
}

// --- 🚀 ОБНОВЛЕНИЕ ЗОН ---
async function updateAllCities() {
    const CITIES_MAP = {
        "msk": "Москва", "spb": "Санкт-Петербург", "kzn": "Казань", 
        "nsk": "Новосибирск", "ekb": "Екатеринбург", "che": "Челябинск"
    };
    await Event.deleteMany({});
    let total = 0;
    for (const [slug, cityName] of Object.entries(CITIES_MAP)) {
        try {
            const url = `https://kudago.com/public-api/v1.4/events/?location=${slug}&fields=place,dates,title&page_size=25&expand=place&actual_since=${Math.floor(Date.now()/1000)}`;
            const { data } = await axios.get(url);
            const events = data.results.filter(i => i.place?.coords).map(i => ({
                city: cityName, title: i.title, address: i.place.address,
                lat: i.place.coords.lat, lng: i.place.coords.lon,
                expireAt: dayjs().add(30, 'minute').toDate()
            }));
            if (events.length > 0) { 
                await Event.insertMany(events); 
                total += events.length; 
            }
        } catch (e) { console.log("Ошибка обновления " + cityName); }
    }
    return total;
}
setInterval(updateAllCities, 600000);

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
        const city = data.split("_")[2];
        ctx.session.step = "edit_fuel_input";
        ctx.session.editingCity = city;
        await ctx.answerCallbackQuery();
        return ctx.reply(`📝 Введите новый текст цен для города **${city}**.\nНапример:\n\`92: 52.50 | 95: 58.30 | ДТ: 62.00 | Газ: 28.50\``);
    }

    if (data.startsWith("reply_")) {
        const targetId = data.split("_")[1];
        ctx.session.replyToUser = targetId;
        await ctx.answerCallbackQuery();
        return ctx.reply(`✍️ Введите сообщение для ответа водителю (ID: ${targetId}):`);
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
        ADMINS.forEach(adminId => bot.api.sendMessage(adminId, `🔔 Новая заявка: ${user.name} (@${ctx.from.username || 'нет'})`));
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
        ctx.answerCallbackQuery("Выполнено");
        bot.api.sendMessage(tid, ok ? "✅ Доступ одобрен на 31 день!" : "❌ Доступ ограничен.");
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name || u.userId}`, `manage_${u.userId}`).row());
        return ctx.editMessageText("✅ Статус обновлен:", { reply_markup: kb });
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    // ЦЕНЫ (АДМИН)
    if (ctx.session.step === "edit_fuel_input" && ADMINS.includes(userId)) {
        await Fuel.findOneAndUpdate({ city: ctx.session.editingCity }, { prices: text }, { upsert: true });
        ctx.session.step = "idle";
        return ctx.reply(`✅ Цены для города **${ctx.session.editingCity}** обновлены!`);
    }

    // ОТВЕТ АДМИНА (ОРИГИНАЛ)
    if (ADMINS.includes(userId) && ctx.session.replyToUser) {
        const targetId = ctx.session.replyToUser;
        try {
            await bot.api.sendMessage(targetId, `📩 **Сообщение от техподдержки:**\n\n${text}`, { parse_mode: "Markdown" });
            await ctx.reply(`✅ Ответ отправлен водителю (ID: ${targetId})`);
        } catch (e) { ctx.reply("❌ Ошибка отправки."); }
        ctx.session.replyToUser = null;
        return;
    }

    // ТЕХПОДДЕРЖКА (ОРИГИНАЛ)
    if (ctx.session.step === "wait_support") {
        ctx.session.step = "idle";
        const supportMsg = `🆘 **НОВОЕ ОБРАЩЕНИЕ В ПОДДЕРЖКУ**\n\n` +
                           `👤 **Водитель:** ${user?.name || 'Неизвестно'}\n` +
                           `🏙 **Город:** ${user?.city || '—'}\n` +
                           `💬 **Сообщение:** ${text}`;
        for (const adminId of ADMINS) {
            await bot.api.sendMessage(adminId, supportMsg, { reply_markup: new InlineKeyboard().text("Ответить 💬", `reply_${userId}`) });
        }
        return ctx.reply("✅ Ваше обращение принято и передано специалистам. Мы ответим вам в этом чате в ближайшее время.\n\n⚠️ *Если вы не получили ответа в течение 60 минут, напишите нам напрямую:* @hotmapfix", { parse_mode: "Markdown" });
    }

    // АНАЛИЗ (ОРИГИНАЛ)
    if (ctx.session.step === "wait_phone") {
        ctx.session.step = "idle";
        await ctx.reply("✅ Ваша заявка принята! Специалист свяжется с вами в ближайшее время.");
        ADMINS.forEach(adminId => {
            bot.api.sendMessage(adminId, `🚀 **НОВАЯ ЗАЯВКА НА АНАЛИЗ**\n\n👤 Имя: ${user?.name || 'Неизвестно'}\n📍 Город: ${user?.city || '—'}\n📞 Номер: ${text}`);
        });
        return;
    }

    if (text === "Открыть карту 🔥") {
        if (ADMINS.includes(userId) || (user?.isAllowed && user.expiryDate > new Date())) {
            return ctx.reply("📍 Карта готова:", { reply_markup: new InlineKeyboard().webApp("Запустить", `${webAppUrl}?city=${encodeURIComponent(user?.city || 'Москва')}`) });
        }
        return ctx.reply("🚫 Нет доступа.");
    }

    if (text === "Буст аккаунта ⚡️") {
        if (ADMINS.includes(userId) || (user?.isAllowed && user.expiryDate > new Date())) {
            return ctx.reply("⚡️ Система ускорения заказов:", { reply_markup: new InlineKeyboard().webApp("Запустить Буст", `${webAppUrl}?page=boost&id=${user?.name || 'Driver'}`) });
        }
        return ctx.reply("🚫 Доступ закрыт.");
    }

    if (text === "Техподдержка 🆘") {
        ctx.session.step = "wait_support";
        return ctx.reply("👋 **Здравствуйте!**\n\nЕсли вы столкнулись с технической неисправностью, пожалуйста, напишите максимально подробно, что именно произошло. Мы изучим ваше обращение и ответим прямо здесь.", { reply_markup: { remove_keyboard: true } });
    }

    if (text === "Анализ аккаунта 🔍") {
        const kb = new InlineKeyboard().text("✅ Согласен", "accept_analysis").text("❌ Отмена", "cancel_analysis");
        return ctx.reply("📈 Вы можете заказать анализ своего аккаунта на предмет теневых ограничений ЯндексGo (теневой бан), проверки уровня коэффициента и получения комплексных рекомендаций.", { reply_markup: kb });
    }

    if (text === "Цены на топливо ⛽️") {
        if (!user) return;
        const f = await Fuel.findOne({ city: user.city });
        const kb = new InlineKeyboard();
        if (ADMINS.includes(userId)) kb.text("Изменить цены 📝", `edit_fuel_${user.city}`);
        return ctx.reply(`⛽️ **Цены ${user.city}:**\n\n${f ? f.prices : "92: — | 95: — | ДТ: — | Газ: —"}`, { parse_mode: "Markdown", reply_markup: kb });
    }

    if (text === "Мой профиль 👤") {
        if (!user) return;
        const exp = user.expiryDate ? dayjs(user.expiryDate).format("DD.MM.YYYY") : "Нет";
        return ctx.reply(`👤 **Профиль:**\nID: ${user.name}\nГород: ${user.city}\nДоступ до: ${exp}`, { parse_mode: "Markdown" });
    }

    // АДМИН ПАНЕЛЬ
    if (text === "Аналитика 📊" && ADMINS.includes(userId)) {
        const uCount = await User.countDocuments();
        const eCount = await Event.countDocuments();
        return ctx.reply(`📊 **Статистика:**\nВодителей: ${uCount}\nЗон: ${eCount}`);
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

// --- API СЕРВЕР ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (req.url.startsWith('/api/points') || req.url.startsWith('/api/data')) {
        const city = url.searchParams.get('city') || "Москва";
        const lat = parseFloat(url.searchParams.get('lat')) || 55.75; 
        const lng = parseFloat(url.searchParams.get('lng')) || 37.61;
        
        const events = await Event.find({ city });
        const taxis = await generateTaxisAroundUser(lat, lng, city);
        
        res.end(JSON.stringify({ events, taxis }));
    } else {
        res.end(JSON.stringify({ status: "running" }));
    }
});
server.listen(process.env.PORT || 8080);