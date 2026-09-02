// FILE: src/__tests__/cbr.test.ts
// VERSION: 1.0.0

import { convertKztToRub, getKztRate } from "../lib/cbr";

describe("M-CBR: KZT conversion", () => {
    beforeEach(() => {
        global.fetch = jest.fn();
        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("converts Steam KZ smallest units into rounded rubles", () => {
        const rubles = convertKztToRub(1000000, { kztValue: 16.1158, kztNominal: 100 });

        expect(rubles).toBe(1612);
    });

    it("fetches the current KZT rate from CBR JSON", async () => {
        const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            Valute: {
                KZT: {
                    Value: 15.5,
                    Nominal: 100,
                },
            },
        })));

        const rate = await getKztRate();

        expect(rate).toEqual({ kztValue: 15.5, kztNominal: 100 });
        expect(fetchMock).toHaveBeenCalledWith("https://www.cbr-xml-daily.ru/daily_json.js");
    });
});
