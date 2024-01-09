const TRUE_SET = new Set([true, 1, 'true', 'TRUE', '1']);
export const isTrue = (t) => TRUE_SET.has(t);

export const today = () => (new Date()).toISOString().slice(0, 10); // YYYY-MM-DD
export const timeOfDay = () => (new Date()).toISOString().substring(11, 11 + 5); // HH:MM

export const frequency = (arr) => {
    const map = Object.create({});
    arr.forEach((value) => {
        map[value] = (map[value] || 0) + 1;
    });
    return map;
};
