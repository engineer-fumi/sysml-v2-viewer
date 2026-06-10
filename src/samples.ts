export interface SampleFile {
  name: string;
  source: string;
}

export interface Sample {
  name: string;
  files: SampleFile[];
}

// ---- 複数ファイル構成のサンプルプロジェクト --------------------------

const vehicleDefinitions = `package VehicleDefinitions {
    doc /* 車両の定義ライブラリ。型 (def) のみを置くファイル。 */

    import ScalarValues::*;

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
}
`;

const vehicleConfiguration = `package VehicleConfiguration {
    doc /* 車両の構成 (usage)。定義は definitions.sysml から import。 */

    import VehicleDefinitions::*;

    part vehicle : Vehicle {
        attribute mass = 1200.0;

        part engine : Engine;
        part fuelTank : FuelTank {
            attribute capacity = 50.0;
        }
        part transmission : Transmission;
        part frontWheels : Wheel[2];
        part rearWheels : Wheel[2];

        connect fuelTank.fuelOut to engine.fuelIn;
        connect engine.drive to transmission.driveIn;
        connection driveShaft connect transmission.driveOut to rearWheels;

        flow of Fuel from fuelTank.fuelOut.fuel to engine.fuelIn.fuel;
    }
}
`;

const vehicleRequirements = `package VehicleRequirements {
    doc /* 車両要求。構成・定義を別ファイルから import して参照する。 */

    import VehicleDefinitions::*;
    import VehicleConfiguration::*;

    requirement def MassLimit {
        doc /* 車両総質量は 1500kg 以下であること。 */
        attribute massLimit : Real = 1500.0;
        subject vehicle : Vehicle;
        require constraint { vehicle.mass <= massLimit }
    }

    requirement def FuelCapacity {
        doc /* 燃料タンク容量は 45L 以上であること。 */
        subject tank : FuelTank;
        require constraint { tank.capacity >= 45.0 }
    }

    requirement vehicleMassRequirement : MassLimit {
        subject vehicle;
    }

    requirement fuelCapacityRequirement : FuelCapacity {
        subject fuelTank;
    }
}
`;

// ---- 単一ファイルのサンプル ------------------------------------------

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
  {
    name: "Vehicle Project (複数ファイル)",
    files: [
      { name: "definitions.sysml", source: vehicleDefinitions },
      { name: "configuration.sysml", source: vehicleConfiguration },
      { name: "requirements.sysml", source: vehicleRequirements },
    ],
  },
  {
    name: "CoffeeMachine (状態機械)",
    files: [{ name: "CoffeeMachine.sysml", source: stateMachine }],
  },
  {
    name: "Actions (アクション)",
    files: [{ name: "Actions.sysml", source: actions }],
  },
];

export const DEFAULT_SAMPLE = SAMPLES[0];
