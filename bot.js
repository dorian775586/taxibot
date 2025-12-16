const { Bot, Keyboard, InlineKeyboard, session } = require("grammy");
const mongoose = require("mongoose");
const http = require("http");
const dayjs = require("dayjs");

// --- ⚙️ НАСТРОЙКИ ---
const token = "7973955726:AAFpMltfoqwO902Q1su5j6HWipPxEJYM3-o";
const webAppUrl = "https://hotmaptaxi-git-main-dorians-projects-14978635.vercel.app";
const mongoUri = "mongodb+srv://user775586:user775586@cluster0.36spuej.mongodb.net/?appName=Cluster0"; 
const ADMIN_ID = 623203896; 

const bot = new Bot(token);

// --- 🏙 СПИСОК ГОРОДОВ ---
const popularCities = ["Москва", "Санкт-Петербург", "Новосибирск", "Екатеринбург", "Казань", "Нижний Новгород", "Челябинск", "Самара", "Омск", "Ростов-на-Дону"];

// --- 🚗 СПИСОК АВТО ---
const carBrands = {
    "Китайские 🇨🇳": ["Chery Tiggo 4/7/8", "Haval Jolion", "Haval F7", "Geely Coolray", "Geely Monjaro", "Exeed LX/TXL", "Changan Alsvin", "Changan CS35", "Omoda C5", "JAC J7", "FAW Bestune"],
    "Корейские 🇰🇷": ["Kia Rio", "Kia Optima", "Kia K5", "Kia Ceed", "Kia Cerato", "Hyundai Solaris", "Hyundai Sonata", "Hyundai Elantra", "Hyundai Creta"],
    "Европейские 🇪🇺": ["VW Polo", "VW Passat", "VW Jetta", "Skoda Octavia", "Skoda Rapid", "Skoda Superb", "Renault Logan", "Renault Sandero", "Renault Arkana"],
    "Японские 🇯🇵": ["Toyota Camry", "Toyota Corolla", "Toyota Prius", "Nissan Almera", "Nissan Qashqai", "Nissan Leaf", "Mazda 6"],
    "Отечественные 🇷🇺": ["Lada Vesta", "Lada Granta", "Lada Largus", "Moskvich 3", "Evolute i-PRO"],
    "Бизнес и Премиум 💎": ["Mercedes E-Class", "BMW 5 Series", "Audi A6", "Hongqi H5", "Voyah Free", "Zeekr 001"]
};

// --- 🗄️ БАЗА ДАННЫХ ---
mongoose.connect(mongoUri);
const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: String, car: String, tariff: String, city: String,
    isAllowed: { type: Boolean, default: false },
    expiryDate: Date, username: String
});
const User = mongoose.model("User", userSchema);

bot.use(session({ initial: () => ({ step: "idle" }) }));

// --- 🛠️ КЛАВИАТУРЫ ---

function getCitiesKeyboard() {
    const kb = new InlineKeyboard();
    popularCities.forEach((city, i) => {
        kb.text(city, `city_${city}`);
        if ((i + 1) % 2 === 0) kb.row();
    });
    kb.row().text("Другой город 🌍", "city_other");
    return kb;
}

function getBrandsKeyboard() {
    const kb = new InlineKeyboard();
    Object.keys(carBrands).forEach((brand, i) => {
        kb.text(brand, `brand_${brand}`);
        if ((i + 1) % 2 === 0) kb.row();
    });
    kb.row().text("Другая 🚗", "brand_Другая");
    return kb;
}

async function showMainMenu(ctx, user) {
    const menu = new Keyboard().text("Открыть карту 🔥").row().text("Мой профиль 👤");
    if (ctx.from.id === ADMIN_ID) menu.row().text("Список водителей 📋");
    
    let statusMsg = user.isAllowed ? "🟢 Доступ разрешен" : "🔴 Доступ закрыт";
    if (user.isAllowed && user.expiryDate) {
        statusMsg += `\n⏰ До конца: ${dayjs(user.expiryDate).diff(dayjs(), 'day')} дн.`;
    }
    await ctx.reply(`🏠 **Главное меню**\nСтатус: ${statusMsg}`, { reply_markup: menu.resized(), parse_mode: "Markdown" });
}

// --- 🚀 ЛОГИКА ---

bot.command("start", async (ctx) => {
    let user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        ctx.session.step = "wait_tariff";
        const kb = new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized();
        await ctx.reply("🚕 Привет! Выберите ваш тариф для регистрации:", { reply_markup: kb });
    } else {
        await showMainMenu(ctx, user);
    }
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;

    if (data.startsWith("city_")) {
        const city = data.split("_")[1];
        if (city === "other") {
            ctx.session.step = "wait_city_text";
            return ctx.editMessageText("🏙 Напишите название вашего города вручную:");
        }
        await User.findOneAndUpdate({ userId }, { city: city });
        ctx.session.step = "wait_name";
        await ctx.editMessageText(`✅ Город: ${city}\n\n📝 **Как к вам обращаться?** (Введите ваше имя)`, { parse_mode: "Markdown" });
    }

    if (data.startsWith("brand_")) {
        const brand = data.split("_")[1];
        if (brand === "Другая") {
            await User.findOneAndUpdate({ userId }, { car: "Другая марка" });
            ctx.session.step = "wait_number";
            return ctx.editMessageText("📝 Введите госномер автомобиля:");
        }
        const models = carBrands[brand];
        const kb = new InlineKeyboard();
        models.forEach((m, i) => { kb.text(m, `model_${brand}_${m}`); if ((i + 1) % 2 === 0) kb.row(); });
        kb.row().text("Другая модель", `model_${brand}_Другая`).row().text("⬅️ Назад", "reselect_brand");
        await ctx.editMessageText(`🚙 ${brand}. Выберите модель:`, { reply_markup: kb });
    }

    if (data === "reselect_brand") {
        await ctx.editMessageText("🚗 Выберите марку:", { reply_markup: getBrandsKeyboard() });
    }

    if (data.startsWith("model_")) {
        const [_, brand, model] = data.split("_");
        await User.findOneAndUpdate({ userId }, { car: `${brand} ${model}` });
        ctx.session.step = "wait_number";
        await ctx.editMessageText(`✅ Выбрано: ${brand} ${model}\n\n🔢 Введите госномер:`);
    }

    // Админ-панель
    if (data === "back_to_list") {
        const users = await User.find();
        const kb = new InlineKeyboard();
        users.forEach(u => { kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name || u.userId}`, `manage_${u.userId}`).row(); });
        await ctx.editMessageText("👥 Список водителей:", { reply_markup: kb });
    }

    if (data.startsWith("manage_")) {
        const tid = data.split("_")[1];
        const u = await User.findOne({ userId: tid });
        const kb = new InlineKeyboard().text("✅ Открыть (31 дн.)", `allow_${tid}`).text("🚫 Закрыть", `block_${tid}`).row().text("⬅️ Назад", "back_to_list");
        await ctx.editMessageText(`👤 Имя: ${u.name}\n🏙 Город: ${u.city}\n🚗 Авто: ${u.car}\n💰 Тариф: ${u.tariff}\n🔓 Доступ: ${u.isAllowed ? "Да" : "Нет"}`, { reply_markup: kb });
    }

    if (data.startsWith("allow_") || data.startsWith("block_")) {
        const [act, tid] = data.split("_");
        const ok = act === "allow";
        const exp = ok ? dayjs().add(31, 'day').toDate() : null;
        await User.findOneAndUpdate({ userId: tid }, { isAllowed: ok, expiryDate: exp });
        await bot.api.sendMessage(tid, ok ? "🎉 Вам открыт доступ на 31 день!" : "❌ Доступ закрыт.").catch(()=>{});
        await ctx.answerCallbackQuery("Статус изменен");
        await ctx.editMessageText("✅ Выполнено!");
    }
});

bot.on("message:text", async (ctx, next) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;

    if (["Открыть карту 🔥", "Мой профиль 👤", "Список водителей 📋"].includes(text)) {
        ctx.session.step = "idle";
        if (text === "Открыть карту 🔥") {
            const u = await User.findOne({ userId });
            if (u?.isAllowed) {
                if (u.expiryDate && dayjs().isAfter(dayjs(u.expiryDate))) {
                    u.isAllowed = false; await u.save();
                    return ctx.reply("⌛️ Срок доступа истек.");
                }
                return ctx.reply("📍 Карта готова!", { reply_markup: new InlineKeyboard().webApp("Запустить", webAppUrl) });
            }
            return ctx.reply("🚫 Доступ закрыт.");
        }
        if (text === "Мой профиль 👤") {
            const u = await User.findOne({ userId });
            const d = u?.expiryDate ? dayjs(u.expiryDate).format("DD.MM.YYYY") : "Нет";
            return ctx.reply(`👤 **Ваш профиль:**\n🏙 Город: ${u.city}\n🚖 Тариф: ${u.tariff}\n🚗 Авто: ${u.car}\n⏳ Доступ до: ${d}`, { parse_mode: "Markdown" });
        }
        if (text === "Список водителей 📋" && userId === ADMIN_ID) {
            const users = await User.find();
            const kb = new InlineKeyboard();
            users.forEach(u => { kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name || u.userId}`, `manage_${u.userId}`).row(); });
            return ctx.reply("👥 Список водителей:", { reply_markup: kb });
        }
        return next();
    }

    let user = await User.findOne({ userId });
    if (!user && ctx.session.step === "wait_tariff") user = new User({ userId });

    switch (ctx.session.step) {
        case "wait_tariff":
            user.tariff = text;
            ctx.session.step = "wait_city";
            await ctx.reply("🏙 Выберите ваш город:", { reply_markup: getCitiesKeyboard() });
            await user.save();
            break;
        case "wait_city_text":
            user.city = text;
            ctx.session.step = "wait_name";
            await ctx.reply("📝 **Как к вам обращаться?** (Введите ваше имя):", { parse_mode: "Markdown" });
            await user.save();
            break;
        case "wait_name":
            user.name = text;
            ctx.session.step = "wait_car_brand";
            await ctx.reply("🚗 Выберите марку машины:", { reply_markup: getBrandsKeyboard() });
            await user.save();
            break;
        case "wait_number":
            user.car = `${user.car} [${text.toUpperCase()}]`;
            ctx.session.step = "idle";
            await user.save();
            await ctx.reply("🏁 Заявка отправлена! Ожидайте активации.");
            await bot.api.sendMessage(ADMIN_ID, `🔔 Новая заявка от ${user.name} (${user.city})!`);
            await showMainMenu(ctx, user);
            break;
    }
});

bot.start();
http.createServer((req, res) => { res.end("OK"); }).listen(process.env.PORT || 8080);