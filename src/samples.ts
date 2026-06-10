export interface Sample {
  name: string;
  source: string;
}

const vehicle = `package VehicleModel {
    doc /* 簡単な車両アーキテクチャのサンプルモデル。
         * part 定義・使用、port、connection、flow を含む。 */

    import ScalarValues::*;

    // ---- 定義 (Definitions) ----
    attribute def Torque;
    attribute def FuelLevel;

    item def Fuel;
    item def Power;

    port def FuelPort {
        out item fuel : Fuel;
    }

    port def DrivePort {
        out item power : Power;
        attribute torque : Torque;
    }

    part def Vehicle {
        attribute mass : Real;
    }

    part def Engine {
        port fuelIn : FuelPort;
        port drive : DrivePort;
        attribute peakTorque : Torque;
    }

    part def FuelTank {
        port fuelOut : FuelPort;
        attribute capacity : Real;
        attribute level : FuelLevel;
    }

    part def Transmission {
        port driveIn : DrivePort;
        port driveOut : DrivePort;
    }

    part def Wheel {
        attribute diameter : Real;
    }

    // ---- 構成 (Usage / Interconnection) ----
    part vehicle : Vehicle {
        attribute mass = 1200.0;

        part engine : Engine {
            attribute peakTorque;
        }
        part fuelTank : FuelTank {
            attribute capacity = 50.0;
        }
        part transmission : Transmission;
        part frontWheels : Wheel[2];
        part rearWheels : Wheel[2];

        // 接続
        connect fuelTank.fuelOut to engine.fuelIn;
        connect engine.drive to transmission.driveIn;
        connection driveShaft connect transmission.driveOut to rearWheels;

        // フロー
        flow of Fuel from fuelTank.fuelOut.fuel to engine.fuelIn.fuel;
    }

    // ---- 要求 (Requirements) ----
    requirement def MassLimit {
        doc /* 車両総質量は 1500kg 以下であること。 */
        attribute massLimit : Real = 1500.0;
        subject vehicle : Vehicle;
        require constraint { vehicle.mass <= massLimit }
    }

    requirement vehicleMassRequirement : MassLimit {
        subject vehicle;
    }
}
`;

const stateMachine = `package CoffeeMachine {
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
`;

const actions = `package Actions {
    doc /* アクションフローのサンプル。 */

    item def Order;
    item def Product;

    action def ProcessOrder {
        in item order : Order;
        out item product : Product;

        action validate {
            in item order = ProcessOrder::order;
        }
        action manufacture;
        action ship {
            out item product;
        }

        first validate then manufacture;
        first manufacture then ship;

        flow of Order from validate to manufacture;
    }
}
`;

export const SAMPLES: Sample[] = [
  { name: "Vehicle (車両構成)", source: vehicle },
  { name: "CoffeeMachine (状態機械)", source: stateMachine },
  { name: "Actions (アクション)", source: actions },
];

export const DEFAULT_SOURCE = vehicle;
