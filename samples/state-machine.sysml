package CoffeeMachine {
    doc /* コーヒーメーカーの状態機械サンプル。 */

    part def CoffeeMaker;

    state def BrewingBehavior {
        entry action initialize;

        state off;
        state idle;
        state heating;
        state brewing;

        transition initial first off accept powerOn then idle;
        transition startHeat first idle accept brewButton then heating;
        transition ready first heating if waterTemp >= 92.0 then brewing;
        transition done first brewing accept brewComplete then idle;
        transition shutdown first idle accept powerOff then off;
    }

    part coffeeMaker : CoffeeMaker {
        exhibit state brewingBehavior : BrewingBehavior;
    }
}
