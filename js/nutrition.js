/* Goal math. Mifflin-St Jeor BMR x activity, adjusted for goal pace. Estimates only. */
const Nutrition = {
  bmr({ gender, age, heightCm, weightKg }) {
    const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
    return gender === 'female' ? base - 161 : base + 5;
  },
  // 1 kg of body fat ~ 7700 kcal. rateKgPerWeek is positive for gain, negative for loss.
  targets(p) {
    const tdee = this.bmr(p) * Number(p.activity || 1.2);
    let delta = 0;
    if (p.goal === 'lose') delta = -(Number(p.rate || 0.5) * 7700) / 7;
    if (p.goal === 'gain') delta = (Number(p.rate || 0.5) * 7700) / 7;
    let calories = Math.round(tdee + delta);
    const floor = p.gender === 'female' ? 1200 : 1500;
    if (calories < floor) calories = floor;
    // Protein ~1.6 g/kg, capped at 35% of calories. Fat 25% of calories. Carbs fill the rest.
    let protein = Math.round(1.6 * p.weightKg);
    const maxPro = Math.round((calories * 0.35) / 4);
    if (protein > maxPro) protein = maxPro;
    const fat = Math.round((calories * 0.25) / 9);
    let carbs = Math.round((calories - protein * 4 - fat * 9) / 4);
    if (carbs < 50) carbs = 50;
    return { calories, protein, carbs, fat, tdee: Math.round(tdee) };
  },
  cmFromFtIn(ft, inch) { return Math.round((Number(ft || 0) * 12 + Number(inch || 0)) * 2.54); },
  kgFromLb(lb) { return Math.round(Number(lb || 0) * 0.45359237 * 10) / 10; },
  lbFromKg(kg) { return Math.round(Number(kg || 0) / 0.45359237 * 10) / 10; },
};
